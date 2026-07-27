# SAPPO time-aware recommendations

## Root cause

Opening-hours data already existed in the backend: Google Places requests `currentOpeningHours` and `regularOpeningHours`, and the result is stored in `venues.opening_hours` (`JSONB`, created in migration `001_init.sql`). The recommendation pipelines did not use that data consistently:

- `planNight` and Concierge's Gemini shortlist selected venues by category, rating and distance without selecting against hours.
- Gemini could introduce an unverified place that had no opening-hours check.
- Roulette only used a limited same-moment parser and treated missing hours as acceptable.
- Google live candidates exposed `openingHours`, but Roulette's mapper read a different property, losing those hours before scoring.

No frontend filter is used for this feature.

## New behaviour

`src/services/openingHours.js` is the single backend authority for availability.

1. Google/DB hours are normalised into `isOpenNow`, `opensAt`, `closesAt`, `openingHours`, `nextOpenTime` and `timezone`.
2. Candidates with missing hours, closed hours or an insufficient remaining opening window are removed before Gemini receives them.
3. Gemini may only select from pre-checked database venues.
4. The returned itinerary is rebuilt against each stop's estimated arrival time. A closed stop is skipped and replaced from the remaining eligible pool.
5. Roulette applies the same strict gate to both stored and live Google candidates.

Missing hours are intentionally **not** assumed to mean open. If nothing qualifies, the API returns `no_open_venues` with an honest alternative message rather than inventing a closed plan.

## Arrival estimation

The planner starts from the request time, adds an approximate walk to the first stop, then for each subsequent stop adds:

- estimated walking travel time from coordinates (5 km/h, minimum 3 minutes);
- a category-based stop duration: café 45 minutes, restaurant 90, museum/attraction 90, bar/music 75;
- the previous stop's duration and journey time.

The evaluator requires the venue to remain open for the whole expected stop, not merely at the moment of arrival. It supports normal weekly periods, overnight hours and Google’s 24-hour representation.

## API fields

Venue profiles, plan stops and Roulette venue responses expose, where data exists:

```json
{
  "isOpenNow": true,
  "opensAt": "...",
  "closesAt": "...",
  "openingHours": ["Monday: 09:00 – 17:00"],
  "nextOpenTime": "...",
  "timezone": "Europe/London"
}
```

Plan stops additionally include `arrival`, with the estimated arrival time and the explainable reason, for example: “Included because your visit is planned for 18:15.”

## Files changed

- `src/services/openingHours.js` — normalisation, availability evaluation, sequence timing and daypart rules.
- `src/services/planNight.js` — strict candidate gate, pre-Gemini filtering, per-stop revalidation and fallback handling.
- `src/routes/concierge.js` — verified-hours shortlist and post-selection revalidation.
- `src/clients/gemini.js` — Gemini is instructed to use only pre-checked DB venues.
- `src/routes/roulette.js` and `src/services/rouletteEngine.js` — strict live/stored candidate gate and corrected Google-hours mapping.
- `src/services/venueProfile.js` — normalised profile API fields.
- `src/routes/plan.js` — passes user coordinates to the planner and returns honest no-open results.

## Schema changes

None. The existing `venues.opening_hours JSONB` column stores the normalised Google data. A future migration is optional only if SAPPO needs to query opening periods directly in SQL at large scale.

## Tests

`npm test` runs `test/openingHours.test.js`, covering:

- venue open now;
- venue closed now;
- venue opening before planned arrival;
- itinerary crossing closing time;
- overnight venues;
- 24-hour venues;
- missing opening hours;
- Google Places hour normalisation;
- per-stop arrival estimation;
- late-evening café versus bar time appropriateness.
