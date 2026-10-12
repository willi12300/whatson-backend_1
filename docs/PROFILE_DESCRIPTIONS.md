# Sourced profile descriptions

`GET /profile-descriptions/venue/:id` uses descriptions published on the venue's
recorded official website. It accepts matching business structured data or page
description metadata tied to the venue name. Only previously indexed website
hosts are eligible. Redirects must stay on that website. Blocked or unidentified
sources fall back to existing profile content; no description is invented.

The separate `venue_description_sources` table stores a bounded source excerpt,
source URL, content hash, check time, expiry and identity key. There is one row per
venue, overwritten on refresh. The key includes the current venue ID, name,
website and extractor version. Records expire after 24 hours and stale excerpts
are not served. Failed checks also expire after 24 hours to avoid repeated fetches.
Photos, menus, reviews, saved items and canonical venue rows are never cached or
modified by this feature. A single excerpt can be cleared by deleting its row
from `venue_description_sources`, without clearing any profile data.

`GET /profile-descriptions/event/:id` reads the latest synced provider record each
time. It retains organiser descriptions, line-up names and separate entry notes.
It adds no second event cache and no paid provider requests. Provider website
links identify the source; text is plain and bounded. No AI rewriting or inferred
atmosphere, facilities, accessibility or age rules are used.

The browser retains neither response in local storage and discards in-flight
responses after the user changes profiles. The existing introduction remains
visible while a venue source is checked. Source links and check dates accompany
venue excerpts. Price/availability data remain separate from descriptive text.
