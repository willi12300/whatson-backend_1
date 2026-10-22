# Venue name and identity accuracy

The Cabin Club (ID 7091, OSM node/4515387429 at Wood Street) was enriched
with The Cavern Club's Google place, photos, website, phone and social accounts.
The Cavern's own FAQ confirms 10 Mathew Street, Liverpool L2 6RE:
https://www.cavernclub.com/the-cavern-club-liverpool/cavern-club-liverpool-faq/
Liverpool City Council lists the distinct Cabin Club at 139–141 Wood Street:
https://licensing.liverpool.gov.uk/PAforLalpacLIVE/1/LicensingActPremises/Search/2598?Column=LTY_DESC&Direction=Ascending

Do not rename the Cabin record or move saved-plan references to another business.
Migration 022 creates/reuses a separate Cavern record only if the cached Google
source has the exact Cavern name, expected place ID and Mathew Street coordinates.
It archives the original venue/source, moves only that Google source and detaches
the incorrect direct Google association from the Cabin. If evidence has changed,
it leaves records untouched. Missing/unexpected source evidence requires review.
The Cabin's suspect provider data is withheld by the reviewed response policy.
No closing status, new Cabin website or unverified replacement name is invented.

## Catalogue-wide checks

`node scripts/audit-venue-names.js` reads every catalogue page, compares available
cached source identities, and flags reused Google photo/place identities and
names needing corroboration. It produces a CSV, JSON and coverage summary in
`reports/venue-names*`. A collision may be a legitimate alias or duplicate; it is
not an instruction to rename or merge records automatically. Numeric venue names
can also be legitimate. The published scan covers 10,209 records, with 152 flagged
records including the two reviewed business identity conflicts. All uncorroborated
records remain explicitly unverified. It does not certify every venue name.

The live backend at scan time did not have `/venue-link-audit/catalogue`, so its
cached provider payloads could not be compared remotely. The report explicitly
records this missing coverage. After deployment, startup and a 15-minute refresh
compare **every venue** with **every cached Google source** in the database.
Missing names/locations are review cases. Google resource IDs are not names.
`/venue-link-audit/names` exposes the paginated result and total coverage counts,
without raw provider payloads or credentials. Provider agreement is not independent
verification of a venue's current trading name.

Conflicting cached identities are quarantined before profile enrichment, and
across JSON responses (including cached photos, socials, ratings and hours).
Generic words such as “club” cannot establish a name match. Pub/club/restaurant
name distinctions are retained. A historically incorrect Google association
cannot rename/move the original venue during sync. Changes in trading name or
branch location require review; they are not silently guessed.

## Deployment and verification

Deploy latest `main` on Railway; a new APK is unnecessary. Verify:

- `/venues/7091/profile` retains Cabin identity but has no Cavern links/photos.
- Search for Cavern returns a separate The Cavern Club at Mathew Street, if the
  reviewed source prerequisites were present; the Cavern Pub/Restaurant remain
  separate businesses.
- `/venue-link-audit/names` has a non-null timestamp and counts for the full DB.
- Run the audit script again with the extended snapshot; review each flagged
  record against venue-owned and address evidence before correcting names.

GitHub tests or a successful push alone do not prove Railway deployed the repair.
