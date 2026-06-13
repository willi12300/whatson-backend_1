// src/utils/normalise.ts
// String normalisation for venue name deduplication and matching

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', '&', 'at', 'of', 'in', 'on'])

/**
 * Normalise a venue name for comparison:
 * - lowercase, trim
 * - remove stop words
 * - strip punctuation (apostrophes, hyphens etc.)
 * - collapse whitespace
 *
 * "The Owl & Anchor" → "owl anchor"
 * "Matt and Phred's Jazz Club" → "matt phreds jazz club"
 */
export function normaliseVenueName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''\-]/g, '')          // remove apostrophes and hyphens
    .replace(/[^a-z0-9\s]/g, ' ')   // replace other punctuation with space
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ')
    .trim()
}

/**
 * Normalise an address for comparison
 * "90 Seel Street, Liverpool, L1 4BH" → "90 seel street liverpool l1 4bh"
 */
export function normaliseAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract postcode from address string
 * Works for UK postcodes: "L1 4BH", "M1 1AB", "E1W 2RG" etc.
 */
export function extractPostcode(address: string): string | null {
  const match = address.match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}/i)
  return match ? match[0].toUpperCase().replace(/\s+/, ' ') : null
}

/**
 * Extract website domain for cross-source matching
 * "https://www.thecavernclub.com/events" → "thecavernclub.com"
 */
export function extractDomain(url: string): string | null {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/**
 * Normalise phone number to digits only for comparison
 * "+44 151 123 4567" → "441511234567"
 * "0151 123 4567" → "01511234567"
 */
export function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}
