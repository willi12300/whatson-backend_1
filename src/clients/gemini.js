// src/clients/gemini.js
// Calls Google's Gemini API (free-tier model gemini-2.5-flash).
// Key stays server-side only.

const axios = require('axios')
const logger = require('../utils/logger')

const MODEL = 'gemini-2.5-flash'
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

const KEY = () => process.env.GEMINI_API_KEY

/**
 * Ask Gemini to return strict JSON. We instruct it to reply with JSON only,
 * then parse defensively (stripping any code fences).
 * Returns parsed object, or null on failure.
 */
async function generateJSON(prompt, { temperature = 0.9 } = {}) {
  if (!KEY()) { logger.warn('GEMINI_API_KEY missing'); return null }
  try {
    const res = await axios.post(
      URL,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          responseMimeType: 'application/json',
        },
      },
      {
        headers: { 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' },
        timeout: 25000,
      }
    )
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (err) {
    const status = err.response?.status
    const msg = err.response?.data?.error?.message || err.message
    logger.error(`Gemini failed (${status}):`, msg)
    return null
  }
}

module.exports = { generateJSON, chatJSON, chatText, buildItinerary, MODEL }

/**
 * Build a hybrid itinerary. Gemini gets the conversation + our verified DB venues,
 * and is told to PREFER our venues but fill gaps with real places it knows (with
 * addresses). Returns { title, summary, stops:[{name, address, why, verified, dbId}] }.
 */
async function buildItinerary(system, conversation, dbVenues, { temperature = 0.8, weather = null } = {}) {
  if (!KEY()) return null
  try {
    const venueLines = dbVenues.map(v =>
      `DB#${v.id} | ${v.name} | ${v.category_slug} | ${v.address || 'addr?'} | rating ${v.rating || '?'}`
    ).join('\n')

    const prompt = `You are Sappo, a warm local travel guide building a real itinerary. You help visitors make the most of a place — create an experience that fits exactly what they asked for and their time/constraints.

Here is the conversation so far:
${conversation.map(m => `${m.role === 'user' ? 'User' : 'Sappo'}: ${m.text}`).join('\n')}

Here are VERIFIED venues from our database (prefer these where they genuinely fit the request):
${venueLines || '(none available for this city/type)'}

${weather ? `REAL WEATHER right now: ${weather.current?.temp ?? '?'}°C, ${weather.current?.condition || ''}. ${weather.planningHint?.note || ''}\nUse ONLY this real weather data — do NOT invent times or conditions. If it says rain later, you can lean indoor for later stops. If no rain is mentioned, don't claim there is any.` : 'No weather data available — do NOT mention specific weather, times, or rain.'}

Build a 3-stop itinerary that matches what the user ACTUALLY asked for (match their food/drink/activity/music requests — don't substitute unrelated venues like hotels). Rules:
- PREFER the verified DB venues above when they fit — reference them by their DB# id in "dbId".
- If our database doesn't have what they want (e.g. a specific food, live music, a skatepark), use a REAL well-known place you know in this city, with its actual address. Never invent fake places.
- Respect their time and constraints (e.g. if they've two hours near a station, keep it tight and close).
- Every stop MUST have a real address.
- Order the stops so they flow well.

Reply ONLY with JSON:
{
  "title": "catchy name for the outing",
  "summary": "one warm line about the plan",
  "reasoning": "a sentence or two, like a mate, on why these stops and how they flow",
  "tip": "one useful insider tip",
  "stops": [
    { "dbId": "<DB# number if it's one of ours, else null>", "name": "place name", "address": "full real address", "category": "food|drink|activity|music|culture|view|other", "why": "short human reason this fits" }
  ]
}`

    const res = await axios.post(
      URL,
      { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature, responseMimeType: 'application/json', maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } },
      { headers: { 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' }, timeout: 30000 }
    )
    const cand = res.data?.candidates?.[0]
    const text = cand?.content?.parts?.map(p => p.text || '').join('') || ''
    const clean = text.replace(/```json|```/g, '').trim()
    if (!clean) {
      logger.error('[gemini] buildItinerary empty. finishReason=' + (cand?.finishReason || '?'))
      return null
    }
    try {
      return JSON.parse(clean)
    } catch (pe) {
      logger.error('[gemini] buildItinerary bad JSON: ' + clean.slice(0, 200))
      return null
    }
  } catch (err) {
    logger.error('[gemini] buildItinerary failed:', err.response?.data?.error?.message || err.message)
    return null
  }
}

/**
 * Plain-text multi-turn chat — Gemini just talks, no JSON straitjacket.
 * This is what lets the conversation "breathe". Returns a string (or null).
 */
async function chatText(system, history, { temperature = 1.0 } = {}) {
  if (!KEY()) { logger.warn('GEMINI_API_KEY missing'); return null }
  try {
    const contents = history.map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }))
    const res = await axios.post(
      URL,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: Math.min(temperature, 1.0), maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      },
      { headers: { 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' }, timeout: 25000 }
    )
    const cand = res.data?.candidates?.[0]
    // Pull text from any/all parts (sometimes split across parts).
    const parts = cand?.content?.parts || []
    const text = parts.map(p => p.text || '').join('').trim()
    if (!text) {
      logger.error('[gemini] empty text. finishReason=' + (cand?.finishReason || '?') + ' raw=' + JSON.stringify(res.data).slice(0, 400))
      return null
    }
    return text
  } catch (err) {
    const status = err.response?.status
    const msg = err.response?.data?.error?.message || err.message
    logger.error(`Gemini text failed (${status}):`, msg)
    return null
  }
}

/**
 * Multi-turn conversation with Gemini. Pass the FULL history so it has memory
 * (this is what stops the looping). `system` sets the persona/instructions.
 * `history` is [{ role:'user'|'model', text }]. Returns parsed JSON or null.
 */
async function chatJSON(system, history, { temperature = 0.95 } = {}) {
  if (!KEY()) { logger.warn('GEMINI_API_KEY missing'); return null }
  try {
    const contents = history.map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }))
    const res = await axios.post(
      URL,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature, responseMimeType: 'application/json' },
      },
      {
        headers: { 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' },
        timeout: 25000,
      }
    )
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (err) {
    const status = err.response?.status
    const msg = err.response?.data?.error?.message || err.message
    logger.error(`Gemini chat failed (${status}):`, msg)
    return null
  }
}
