# General venue search

Search covers names, addresses, categories, recorded cuisines/menu summaries and
terms extracted from venues' published websites and readable menus. Search is
not restricted to a fixed list of dish types. Food terms prefer food-capable
venues so visitor directories and parks do not become burger recommendations.

The initial Liverpool pass checked 810 website-bearing catalogue entries, with
readable documents for 582. Missing/blocked pages and image-only menus are gaps;
no dishes are invented for them. Indexed matches identify their menu/website URL
and checking date. A website mention is not a guarantee of current availability.
The four previously reviewed burger entries remain supplementary evidence.

Rebuild with a current catalogue response:

    python scripts/build_venue_search_index.py --catalogue catalogue.json --refresh

The crawler uses public pages, limits requests and response size, caches shared
URLs, reads textual PDFs with pdftotext, and skips social pages and empty shells.
It stores a term index and document hash, not full scraped page copy. Runs on the
same day can resume; a new checking day re-fetches sources so old evidence is
not labelled freshly checked. Review changes, run tests and deploy the index.

Server SQL remains parameterised. Index evidence is tied to both a venue ID and
its name. Renamed/reassigned records cannot silently inherit another venue's
source. Closed venues are excluded from search. No paid data-provider calls or
catalogue mutations are needed to build this index.
