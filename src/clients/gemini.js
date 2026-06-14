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

module.exports = { generateJSON, MODEL }
