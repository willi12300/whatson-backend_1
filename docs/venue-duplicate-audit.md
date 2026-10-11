# Venue duplicate audit — 11 October 2026

Scanned all 10,186 catalogue records across every import area. Reviewed nearby name/contact/address matches and repeated exact names across larger distances. Confirmed 73 duplicate pairs. Kept separate branches, cafes inside attractions, unrelated nearby businesses, and unresolved matches separate.

On startup, the reviewed manifest is applied in one transaction. Name and coordinate guards skip changed records. Every canonical and duplicate row, related foreign-key record and embedded-plan reference is archived before merging. Duplicate profile IDs resolve through `venue_aliases`. Archives are private database records, never returned by the public API.

The preferred record supplies venue facts; the established canonical ID/name/city remain stable. Claimed profiles take priority and two claimed profiles require review. Galleries combine only when Google identities are compatible; conflicting/distant enrichment records are archived. Rating/review counts are retained, not added together. Events, offers, check-ins, missions and interaction history move intact. Popularity counters combine while unique-person counts continue to derive from interaction history.

Incoming imports use provider identities and a conservative name/location/address match across city labels. Reviewed old names and entrance coordinates are also recognised. Identity checks and inserts run in a serialised transaction. Event stubs use the same import entry point.

## Confirmed merges

| Retained ID | Duplicate ID | Retained name | Duplicate name |
| --- | --- | --- | --- |
| 6245 | 6338 | Wavertree Botanic Garden and Park | Wavertree Botanic Walled Garden Edge Lane |
| 7463 | 51983 | Stanleys | Stanleys |
| 7467 | 51990 | Farmers Arms | Farmer's Arms |
| 31 | 7328 | Bean Coffee Roasters | Bean Coffee Roasters |
| 6998 | 51656 | North Star | North Star |
| 7333 | 51306 | Indigo | Indigo |
| 7532 | 60 | PINS | PINS Social Club Liverpool |
| 7572 | 51853 | The Rocket | The Rocket Pub & Kitchen |
| 70 | 7307 | Bamboo Brunch And Cocktails | Bamboo |
| 7271 | 52277 | The Mess | The Mess, Fort Perch Rock |
| 19823 | 19827 | Finch Station Shop & Cafe | Finch Square Shop and Cafe |
| 19304 | 19311 | The Lamb Of Rhos | The Lamb Of Rhos |
| 7128 | 51295 | The Acorn | The Acorn |
| 7534 | 51957 | The Nelson | The Nelson |
| 7473 | 51290 | The Bridge Inn | Bridge Inn |
| 26296 | 26303 | Menai Bridges Museum | Menai Bridge Community Heritage Trust Ltd |
| 7417 | 7715 | Soho Bar Liverpool | Soho Bar Liverpool |
| 27109 | 27125 | The Port Inn | The Port Inn |
| 6980 | 52260 | The Seahorse | Seahorse |
| 6990 | 51949 | The Lighthouse | Lighthouse |
| 6796 | 11884 | Stag and Rainbow | Stag And Rainbow Beefeater |
| 7044 | 52275 | The Olive Tree | The Olive Tree Bistro |
| 7296 | 52394 | Carlisi | Carlisi |
| 13506 | 13507 | Fenfig fish bench | Kenfig fish bench |
| 108 | 6725 | Birkenhead Park | Birkenhead Park |
| 6820 | 51808 | The Willow Bank | Willow Bank Tavern |
| 6808 | 51323 | The Railway Inn | The Railway Inn |
| 7116 | 7314 | Thoughtfully Cafe | Thoughtfully Cafe |
| 7225 | 8065 | Core Coffee & Kitchen | Core Coffee & Kitchen |
| 7626 | 51330 | The Mersey Clipper | The Birch Tree |
| 7627 | 51988 | The Tower | Tower Hotel |
| 7560 | 53020 | The Railway | The Railway |
| 6985 | 51989 | The Queens | The Queens Arms |
| 7305 | 7890 | The Raven - JD Wetherspoon | The Raven - JD Wetherspoon |
| 6943 | 7928 | The Albion | The Albion |
| 6727 | 7457 | Fort Perch Rock | Fort Perch Rock |
| 7475 | 51298 | King's Arms | Kings Arms |
| 7769 | 12687 | The Alexandra | The Alexandra Pub |
| 6959 | 51324 | Prenton Park | Prenton Park |
| 7496 | 54750 | The Grapes | The Grapes |
| 7544 | 51464 | The Victoria | The Victoria |
| 6986 | 51980 | The Boot | The Boot |
| 6939 | 51316 | The Halfway House | Halfway House |
| 7090 | 10254 | Cafe Tabac | Cafe Tabac |
| 7466 | 51986 | The Cheshire Cheese | The Cheshire Cheese |
| 6902 | 51623 | Caernarfon Castle | Caernarvon Castle |
| 7607 | 51270 | The Woodchurch Hotel | The Woodchurch |
| 3315 | 6954 | Gran Caffe Lark Lane | Gran Caffè |
| 7547 | 11889 | The Park | The Park Pub Anfield |
| 7546 | 11886 | The Albert | The Albert Pub Anfield |
| 46 | 7646 | BLUNDELL STREET SUPPER CLUB | Blundell Street |
| 6780 | 51462 | The Masonic | The Masonic Pub |
| 7656 | 51855 | Richmond Tavern | The Richmond |
| 6813 | 51318 | The Wellington | Wellington |
| 7449 | 51328 | The Bedford | The Bedford -“Luke’s” |
| 7386 | 54242 | Black Cat | Black Cat Rose Lane |
| 26262 | 26284 | Plas Cadnant Hidden Gardens | Plas Cadnant |
| 23243 | 23244 | Wern Mynach | Wern Mynach Community Garden |
| 19839 | 19847 | The Rampin (Masons Arms) | Masons Arms |
| 7489 | 51706 | Gallaghers | Gallaghers Traditional Pub |
| 6978 | 51327 | The Rock Villa | The Rock Villa - More Drinks! |
| 61 | 6247 | Liverpool Pier Head | Pier Head Liverpool |
| 14875 | 14894 | Ynysangharad War Memorial Park | Ynysangharad Park |
| 3318 | 7338 | Handyman Pub | Handyman |
| 6957 | 52281 | The Clarence | Clarence Hotel Wallasey |
| 7477 | 51317 | Rose and Crown | Rose & Crown |
| 7570 | 52537 | The Wheatsheaf | Wheatsheaf |
| 7242 | 7261 | The Old Bank Alehouse | The Old Bank |
| 6928 | 52255 | The Magazines | The Magazine Hotel |
| 7585 | 51433 | Toby Carvery | Toby Carvery Aigburth |
| 6964 | 51325 | The Beehive | The Beehive Pub |
| 6243 | 6257 | Princes Park | Princes Park |
| 9464 | 9499 | Parc del Fòrum | Parc del Fòrum |

## Verification

Ran all 16 migrations and all 73 merges in PostgreSQL (PGlite) against the complete public catalogue snapshot. Verified foreign keys, popularity counters, embedded plans, aliases, recovery snapshots, rollback after an injected failure, repeat runs and rediscovery at an old entrance. Backend tests and frontend alias migration tests cover branch/amenity separation, provider clustering, local Saved/My Plan deduplication and existing save/remove actions.

For recovery, use `venue_merge_archive.canonical_before`, `duplicate_before` and `related_before` in a controlled database transaction. These snapshots include the exact pre-merge rows. Recovering after new activity requires reconciling that newer activity rather than blindly overwriting it.
