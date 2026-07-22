const { randomUUID } = require('crypto')
const logger = require('../utils/logger')
const { normaliseRecommendationRequest } = require('./recommendationIntent')
const { filterAndShortlist } = require('./recommendationScoring')
const { planExperienceWithGemini } = require('./recommendationPlanner')
const { validateExperience } = require('./recommendationValidator')
const { deterministicFallbackPlan } = require('./recommendationFallback')

function createRecommendationEngine(deps = {}) {
  const normalise = deps.normaliseRecommendationRequest || normaliseRecommendationRequest
  const gather = deps.gatherRecommendationContext || ((...args) => require('./recommendationCandidates').gatherRecommendationContext(...args))
  const shortlistFn = deps.filterAndShortlist || filterAndShortlist
  const plan = deps.planExperienceWithGemini || planExperienceWithGemini
  const validate = deps.validateExperience || validateExperience
  const fallback = deps.deterministicFallbackPlan || deterministicFallbackPlan
  const log = deps.logger || logger
  const generate = deps.generateJSON || ((...args) => require('../clients/gemini').generateJSON(...args))

  return async function recommend(input = {}) {
    const requestId = randomUUID()
    const started = Date.now()
    const stages = []
    const stage = (name, at) => stages.push({ name, durationMs: Date.now() - at })
    const safeLog = (status, extra = {}) => log.info('[recommendations]', JSON.stringify({
      requestId,
      status,
      mode: input.mode || 'tell_sappo',
      city: input.location?.city || input.city || null,
      durationMs: Date.now() - started,
      ...extra,
    }))

    let tick = Date.now()
    const intent = await normalise(input, {
      generateJSON: generate,
      now: deps.now || new Date(),
    })
    stage('understanding_request', tick)
    safeLog('intent_normalised', {
      interests: intent.interests?.length || 0,
      avoidances: intent.avoid?.length || 0,
      accessibilityNeeds: intent.accessibility?.length || 0,
      durationMinutes: intent.durationMinutes,
      radiusMiles: intent.radiusMiles,
      hasUserHistoryKey: !!(intent.userId || intent.deviceId),
    })

    tick = Date.now()
    let context
    try {
      context = await gather(intent, deps)
    } catch (error) {
      log.error('[recommendations]', JSON.stringify({ requestId, status: 'context_failed', error: error.name || 'Error' }))
      return {
        experience: null,
        message: 'I could not check enough live local information to build a trustworthy plan. Please try again shortly.',
        meta: { requestId, strategy: 'none', stages },
      }
    }
    stage('checking_local_options', tick)
    safeLog('context_gathered', {
      venueCount: context.venues.length,
      eventCount: context.events.length,
      weatherAvailable: !!context.weather?.current,
    })

    tick = Date.now()
    const shortlist = shortlistFn(context, deps.shortlistOptions)
    stage('ranking_matches', tick)
    const rejectionReasons = shortlist.rejected.reduce((counts, item) => {
      counts[item.reason] = (counts[item.reason] || 0) + 1
      return counts
    }, {})
    safeLog('candidates_shortlisted', {
      shortlistedVenues: shortlist.venues.length,
      shortlistedEvents: shortlist.events.length,
      rejected: shortlist.rejected.length,
      rejectionReasons,
    })
    if (!shortlist.all.length) {
      safeLog('no_candidates', { venueCount: context.venues.length, eventCount: context.events.length })
      return {
        experience: null,
        message: 'I could not find enough verified nearby options that fit those constraints. Try a wider area, more time, or fewer avoidances.',
        meta: { requestId, strategy: 'none', stages, providerAudit: context.providerAudit },
      }
    }

    let strategy = 'gemini'
    tick = Date.now()
    let rawPlan = await plan(context, shortlist, {
      generateJSON: generate,
      previousPlan: intent.mode === 'refine' ? intent.currentExperience : null,
    })
    stage('building_experience', tick)
    if (!rawPlan) safeLog('planner_parse_failed')
    tick = Date.now()
    let result = await validate(rawPlan, context, shortlist, deps)
    stage('validating_plan', tick)

    if (!result.valid) {
      safeLog('validation_failed', { validationErrors: result.errors.length, repairAttempt: 1 })
      strategy = 'gemini_repair'
      tick = Date.now()
      rawPlan = await plan(context, shortlist, {
        generateJSON: generate,
        previousPlan: rawPlan,
        validationErrors: result.errors,
      })
      stage('repairing_plan', tick)
      tick = Date.now()
      result = await validate(rawPlan, context, shortlist, deps)
      stage('revalidating_plan', tick)
      if (!result.valid) safeLog('repair_failed', { validationErrors: result.errors.length })
    }

    if (!result.valid) {
      strategy = 'deterministic_fallback'
      tick = Date.now()
      const fallbackPlan = fallback(context, shortlist)
      result = fallbackPlan
        ? await validate(fallbackPlan, context, shortlist, deps)
        : { valid: false, errors: ['no safe fallback plan'], experience: null }
      if (result.experience) {
        result.experience.warnings = [...new Set([
          ...(result.experience.warnings || []),
          'SAPPO used its deterministic fallback because the AI planner could not produce a fully valid plan.',
        ])]
      }
      stage('building_safe_fallback', tick)
    }

    if (!result.valid || !result.experience) {
      safeLog('no_valid_plan', {
        strategy,
        candidates: shortlist.all.length,
        validationErrors: result.errors?.length || 0,
      })
      return {
        experience: null,
        message: 'I found local options, but I could not make a plan I could validate safely. Please adjust the time or constraints and try again.',
        meta: { requestId, strategy: 'none', stages, providerAudit: context.providerAudit },
      }
    }

    safeLog('ok', {
      strategy,
      candidates: shortlist.all.length,
      stops: result.experience.stops.length,
      warnings: result.experience.warnings.length,
      validationErrors: result.errors?.length || 0,
    })
    return {
      experience: result.experience,
      meta: {
        requestId,
        strategy,
        stages,
        generatedAt: new Date().toISOString(),
        candidateCounts: { venues: shortlist.venues.length, events: shortlist.events.length },
        providerAudit: context.providerAudit,
      },
    }
  }
}

const recommendationEngine = createRecommendationEngine()
module.exports = { createRecommendationEngine, recommendationEngine }
