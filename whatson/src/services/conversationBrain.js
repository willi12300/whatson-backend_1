// src/services/conversationBrain.js
// Gemini's ONLY job here is extraction + phrasing — it does NOT control flow.
// Deterministic code (in the route) decides whether to ask or plan, using a
// persistent conversation_state. This makes conversational loops impossible.

const { generateJSON } = require('../clients/gemini')
const { parseIntent } = require('./parseIntent')
const logger = require('../utils/logger')

// The canonical conversation state shape.
function emptyState() {
  return {
    city: null,          // resolved city name
    cityMention: null,   // city named in conversation
    budget: null,        // 'cheap' | 'moderate' | 'premium'
    budgetPerPerson: null,
    vibe: null,          // chilled | chaos | cheap | date_night | hidden_gems | stag_hen
    categories: [],      // restaurant, cafe, bar, pub, nightclub, music_venue, comedy
    busyPref: null,      // 'avoid' | 'lively'
    timing: null,        // 'tonight' | 'tomorrow' | 'weekend'
    group: null,         // 'couple' | 'group' | 'family' | 'solo'
    occasion: null,      // free text e.g. 'birthday'
    interests: [],       // free-text interests
  }
}

// Merge newly-extracted fields into existing state WITHOUT overwriting good data with null.
function mergeState(prev, next) {
  const out = { ...emptyState(), ...prev }
  for (const k of Object.keys(emptyState())) {
    const v = next?.[k]
    if (v == null) continue
    if (Array.isArray(v)) {
      if (v.length) out[k] = Array.from(new Set([...(out[k] || []), ...v]))
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Extract structured fields from the latest user message, given the running state.
 * Returns { extracted: <partial state>, ack: <short natural acknowledgement or null> }.
 * Falls back to keyword parsing if Gemini is unavailable.
 */
async function extractState(message, prevState, cityContext) {
  // cheap keyword pass always runs (grounding + fallback)
  const kw = parseIntent(message || '')
  const kwExtract = {
    cityMention: kw.cityMention || null,
    budget: kw.budget || null,
    budgetPerPerson: kw.budgetPerPerson || null,
    vibe: kw.vibe || null,
    categories: kw.categories || [],
    busyPref: kw.busyPref || null,
    timing: kw.timing || null,
    group: kw.group || null,
  }

  const prompt = `You extract structured info from a message about planning a day/night out. Do NOT plan, do NOT ask questions. Just extract what is explicitly stated or strongly implied.

Known so far: ${JSON.stringify(slim(prevState))}
City context (their selected city): ${cityContext || 'unknown'}

New user message: "${message}"

Reply ONLY with JSON:
{
  "extracted": {
    "cityMention": null,        // a city name if they mention one
    "budget": null,             // "cheap" | "moderate" | "premium" (treat/fancy=premium, student/skint=cheap)
    "budgetPerPerson": null,    // number if a £ figure is given
    "vibe": null,               // chilled | chaos | cheap | date_night | hidden_gems | stag_hen
    "categories": [],           // restaurant, cafe, bar, pub, nightclub, music_venue, comedy
    "busyPref": null,           // "avoid" if they want quiet, "lively" if they want buzz
    "timing": null,             // tonight | tomorrow | weekend
    "group": null,              // couple | group | family | solo
    "occasion": null,           // e.g. "birthday", "anniversary"
    "interests": []             // any specific interests e.g. ["live music","cocktails"]
  },
  "ack": "a SHORT, warm, natural one-liner reacting to what they said (under 12 words), or null"
}
Only fill fields that are actually present. Infer sensibly (e.g. "date night" → group couple, vibe date_night; "my mates" → group). Leave unknown fields null.`

  const out = await generateJSON(prompt, { temperature: 0.4 })
  if (!out || !out.extracted) {
    logger.warn('[brain] extraction fell back to keywords')
    return { extracted: kwExtract, ack: null }
  }
  // merge keyword hints under Gemini's extraction (Gemini wins where both present)
  const extracted = { ...kwExtract, ...stripNull(out.extracted) }
  if ((!extracted.categories || !extracted.categories.length) && kwExtract.categories.length) extracted.categories = kwExtract.categories
  return { extracted, ack: out.ack || null }
}

function slim(s) {
  const o = {}
  for (const [k, v] of Object.entries(s || {})) {
    if (v == null) continue
    if (Array.isArray(v) && !v.length) continue
    o[k] = v
  }
  return o
}
function stripNull(o) { const r = {}; for (const k in (o || {})) if (o[k] != null) r[k] = o[k]; return r }

module.exports = { extractState, mergeState, emptyState }
