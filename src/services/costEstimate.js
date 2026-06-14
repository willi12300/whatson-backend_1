// src/services/costEstimate.js
// Rough per-person cost estimates from venue price_level + category, plus event
// ticket prices. Everything is clearly an ESTIMATE — never presented as a real price.

// Typical per-person spend (£) by category and price_level (1-4). [min, max].
// These are deliberately broad ranges. price_level 0/undefined → use the middle.
const SPEND = {
  restaurant: { 1: [8, 15], 2: [15, 28], 3: [28, 50], 4: [50, 90] },
  cafe:       { 1: [4, 9],  2: [7, 14],  3: [12, 22], 4: [18, 30] },
  bar:        { 1: [8, 16], 2: [14, 26], 3: [22, 40], 4: [35, 60] },
  pub:        { 1: [7, 14], 2: [10, 20], 3: [16, 30], 4: [25, 45] },
  nightclub:  { 1: [10, 20],2: [18, 35], 3: [30, 55], 4: [45, 80] },
  music_venue:{ 1: [8, 18], 2: [14, 28], 3: [22, 42], 4: [35, 65] },
  comedy:     { 1: [10, 18],2: [15, 28], 3: [25, 42], 4: [35, 60] },
  other:      { 1: [6, 14], 2: [12, 24], 3: [20, 38], 4: [30, 55] },
}

function spendFor(cat, priceLevel) {
  const table = SPEND[cat] || SPEND.other
  const lvl = (priceLevel && priceLevel >= 1 && priceLevel <= 4) ? priceLevel : 2
  return table[lvl]
}

// Estimate total per-person cost across a list of stops (venues), plus any event tickets.
// stops: [{ category_slug, price_level, eventPrice? }]
function estimatePlanCost(stops, { transportPerPerson = 0 } = {}) {
  let min = 0, max = 0
  let hasData = false
  for (const s of stops) {
    const [lo, hi] = spendFor(s.category_slug, s.price_level)
    min += lo; max += hi
    if (s.price_level) hasData = true
    if (s.eventPrice != null && !Number.isNaN(s.eventPrice)) { min += s.eventPrice; max += s.eventPrice }
  }
  min += transportPerPerson
  max += transportPerPerson
  return {
    min: Math.round(min),
    max: Math.round(max),
    label: `£${Math.round(min)}–${Math.round(max)} each`,
    note: 'estimated',
    confidence: hasData ? 'medium' : 'low',
  }
}

// Map a budget level / per-person figure into guidance the AI planner can use.
function budgetGuidance({ budget_level, budget_per_person }) {
  if (budget_per_person) {
    return {
      cap: budget_per_person,
      text: `Keep the whole night around £${budget_per_person} per person or under. Prefer cheaper venues (price_level 1-2), include free or low-cost stops, and avoid premium spots unless one splurge clearly fits the budget.`,
    }
  }
  switch (budget_level) {
    case 'cheap':
      return { cap: 25, text: 'This is a budget night. Strongly prefer price_level 1-2 venues, free events, and cheap eats. Avoid premium venues.' }
    case 'moderate':
      return { cap: 50, text: 'A moderate budget. Mix of price_level 2-3 venues is fine; keep it sensible.' }
    case 'premium':
      return { cap: null, text: 'A premium night — quality over cost. price_level 3-4 venues welcome.' }
    default:
      return { cap: null, text: '' }
  }
}

module.exports = { estimatePlanCost, budgetGuidance, spendFor }
