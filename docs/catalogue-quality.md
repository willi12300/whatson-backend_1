# Catalogue/search fixes

## McCooley's Liverpool — 20 October 2026

User reported both branches missing from Discover search. Live catalogue audit (2,211 Liverpool venues before repair) found no McCooley-named records. Searching `mccooleys` instead returned White Star 7634: its indexed CAMRA directory page contained the nearby McCooley's name. This was page-wide term contamination, not a legitimate match.

Added via the existing `/venues/resolve-profile` endpoint, with Google-backed details and separate branch identities:

- 58324: McCooley's Concert Square, 46–50 Wood Street, Liverpool L1 4AQ. Official source: https://mccooleys.co.uk/concert-square/contact/ . Coordinates 53.4032935, -2.9799349.
- 58325: McCooley's Mathew Street, 9–12 Temple Court, Liverpool L2 6PY. Official source: https://mccooleys.co.uk/mathew-street/contact/ . Coordinates 53.4065945, -2.9866837.

Both profiles load independently with provider photos. No invented opening times or dog access. Existing app's remote search and catalogue refresh receive these records without an APK update.

Search term evidence now excludes directory page documents (CAMRA, Google and TripAdvisor); names/addresses remain searchable and venue-owned website/menu evidence remains available. Website index builder also skips CAMRA going forward. This prevents neighbour listings on a directory page becoming claims about the current venue. Regression covers the actual White Star false match and both official branch domains.

Validation: 95 backend tests pass. Live search spelling variants and installed web bundle checked for both branches, correct profile/address and no White Star contamination after deployment.
