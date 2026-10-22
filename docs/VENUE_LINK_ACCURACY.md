# Venue link accuracy audit

## Reported failure

Venue 7253, Ferraiolo's Italian Bistro, originates at the OSM node https://www.openstreetmap.org/node/10214210825 (53.38345, -2.9390444). Its website/menu and cached Google identity/photo belong to Villa Romana instead. No independent official replacement website has been confirmed. Do not substitute another guessed URL or mark the venue closed from missing evidence.

## Protection implemented

- Require independent provider name AND location agreement (within 200 m) before Google profile enrichment can apply. Stored provider IDs alone are insufficient proof.
- Quarantine the known mixed identity in data/venue-link-audit.json: keep the original venue ID/name/coordinates while withholding unrelated websites, menus, photos, ratings, hours and contact details. Underlying DB records are preserved for review.
- Stop inventing menu links by copying a restaurant homepage into menu_url.
- Apply link policy to every public venue response, not one screen. Alternate website/menu/social wrappers cannot recreate withheld links.
- Do not fetch or publish descriptions from quarantined or unverified websites.
- Preserve dates/binary values during recursive response filtering.

## Catalogue audit

Initial public snapshot contained 10,209 venue records, 6,038 website fields and 3,136 menu fields. The repository-run audit checks every venue, including those without links, fetches unique URLs with bounded concurrency, follows only public HTTP(S) destinations, and records redirects, HTTP status and positive ownership evidence. A successful HTTP response is NEVER sufficient verification. Complete venue-name agreement is required; a single shared word does not establish ownership. Menus must be actual menu destinations on an identity-confirmed venue domain. Social/booking targets need an exact published link from a confirmed venue website.

An inaccessible page is unresolved, NOT proof of a wrong business or closure. Generic names, JS-only sites, chains with uncertain branch identity and shared corporate domains can need human review even when legitimate. Reports are automated screening, not a guarantee of every live business fact.

Run: Actions → Catalogue venue link audit. The workflow publishes downloadable CSV/JSON reports and a separate review branch; it does not silently change production. The public /venue-link-audit/catalogue snapshot exposes only existing public link fields and minimal provider identity, without enrichment, raw responses or keys. If the endpoint has not deployed, the runner falls back to the complete public website/menu catalogue and explicitly does NOT certify social/booking coverage.

Before enabling verified-link enforcement, set enforce_verified_fields to the fields actually covered. Website/menu-only results must not remove or certify unaudited social accounts. Exact venue identity and URL/field must agree with the manifest; new/changed URLs require rechecking. Use the report to investigate unknowns, not to invent replacements.

## Deployment blocker and verification

During this task Railway continued serving the old backend: external GitHub runner saw /health 200, Ferraiolo website/menu/photo still present, and /venue-link-audit/catalogue 404. Repository code/tests alone do not mean this is live. Deploy latest main in Railway service 05abfee8-f49d-40ca-8a2d-e8a5c629e86c (project 3c69d4a9-8d79-4247-9615-adf25dcfc9b0) and verify the actual JSON response before reporting the fix delivered.

Expected after deployment: /venues/7253/profile has website=null, menu_url=null, cover_photo=null, google_place_id=null, and link_identity_status=quarantined. It should no longer direct the user to Villa Romana. Correct coordinates/name remain. Fetch the extended snapshot and rerun the audit for social/booking and provider-identity coverage once available. Do not report all venues verified while any items remain unresolved.
