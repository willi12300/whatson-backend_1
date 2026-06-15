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

module.exports = { generateJSON, chatJSON, MODEL }

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
