# Event coverage

City discovery and artist search now start shared Skiddle and Ticketmaster refreshes regardless of
GPS or stored result count. The server warms Liverpool after startup and refreshes
requested cities hourly. Results cover the next 60 days within each configured
city radius; older stored listings beyond that horizon remain searchable.

Skiddle requests use documented `minDate` / `maxDate` parameters, `order=date`, and
100-result pages until exhaustion. The automatic city refresh has no 200/500-event
cap. `daterange` was undocumented and trending was the provider default, so capped
calls could omit upcoming events. Roulette retains its separate fast cap.

Existing source IDs are updated rather than inserted as new listings. UK-local
doors times are converted using the event date's timezone offset. Future events
previously marked expired are restored to active when their source is refreshed.
The importer reuses venue matches and limits database writes to four workers.

`GET /events?city=Liverpool` includes `refresh` with `status`, `checked_at`,
`fetched`, `saved`, and `skipped`. A failed provider call or import is not marked
fresh; saved listings remain available and the provider is retried after a minute.
An absent provider key reports `unavailable`. Inspect `skipped` for listings
without sufficient venue identity/coordinates. Provider URL/key values are not
logged. No Google venue crawl runs as part of an event refresh.

Each source has its own cache and retry state, under `refresh.providers.skiddle`
and `refresh.providers.ticketmaster`. A successful source stays fresh even when
the other fails. Overall `partial` indicates one source succeeded. Safe failure
reasons distinguish an unconfigured provider, HTTP authentication/rate-limit
failures, and import failures without exposing keys or request URLs.
Ticketmaster refreshes paginate past the former five-page cap and split dense
date windows to respect Discovery API's 1,000-item deep-paging limit.

The frontend renders saved results, checks refresh progress every two seconds,
and replaces them once the shared import finishes. It reports a delayed/failed
refresh instead of presenting an empty result as the final answer during an import.

Validation: `npm test`, plus a live query for `above and beyond` on 17 October 2026
and verification of event source 42596972 / Blackstone Street Warehouse.
