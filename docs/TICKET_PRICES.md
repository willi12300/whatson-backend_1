# Published ticket prices

Event API responses include a `pricing` object. Prices can come from provider API
fields or in-stock Offer objects on the event's official public listing. Unknown
prices remain unknown. Price ranges retain their currency; text-only advertised
prices retain their wording rather than guessing a numeric amount.

`GET /events/:id/pricing` checks and caches the listing for six hours. Only approved
Skiddle and Ticketmaster HTTPS hosts may be fetched, including redirects. Fetches
are shared per event and limited to three concurrent requests. Blocked pages are
not bypassed. Skiddle's detail API is also checked when search omits the price.

The main from-price uses an ordinary ticket where one is available, rather than a
restricted group/child/resale discount. The selected tier's name remains visible,
including early-entry conditions. Profiles list available published tiers. Sold-out,
expired and not-yet-on-sale offers are excluded. Fees and final availability remain
with the provider.

Some provider pages do not publish usable prices from Railway's hosting region.
`scripts/build_ticket_prices.js` builds a public source cache from the current
Liverpool event catalogue; it performs no authenticated checkout or inventory
queries. `.github/workflows/ticket-prices.yml` refreshes that cache every four hours.
Blocked Ticketmaster listings stop further requests to that provider for the run.
Temporary failures retain previously checked records for up to six hours; older
records expire. Each price records its source URL, currency, offer name and check time.

Cards look up prices when visible and profiles check them when opened. Browser
requests are shared and cached for an hour. Tests cover sold-out/group/early-entry
tiers, unknown/free values, currencies, official-host restrictions, SQL joins and
mobile card/profile rendering.
