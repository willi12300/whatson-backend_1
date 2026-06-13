# ⚡ QUICKSTART — Run this in order

Your backend is complete. Here's the exact sequence to get it live.
Every command goes in your terminal, inside the `backend` folder.

## ───────── LOCAL TEST (10 minutes) ─────────

```
1.  npm install
2.  docker-compose up -d          ← starts local database
3.  copy .env.example to .env     ← then paste your API keys into .env
4.  npm run migrate               ← creates the tables
5.  npm run preflight             ← checks keys + DB + tests each API
6.  npm run sync:liverpool        ← pulls REAL Liverpool data (~$2 Google credit)
7.  npm run dev                   ← starts the server
```

Then open in your browser:
- http://localhost:3000/health
- http://localhost:3000/venues?city=Liverpool&limit=10
- http://localhost:3000/events?city=Liverpool

If step 5 (preflight) shows all ✅, everything is wired correctly.

## ───────── GO LIVE ON RAILWAY (15 minutes) ─────────

```
1.  Push this folder to a GitHub repo
2.  railway.app → New Project → Deploy from GitHub repo
3.  + New → Database → Add PostgreSQL
4.  Backend service → Variables tab → add:
        GOOGLE_PLACES_API_KEY
        FOURSQUARE_API_KEY
        SKIDDLE_API_KEY
        EVENTBRITE_TOKEN
        SYNC_SECRET           (make up a long random string)
        NODE_ENV = production
    (DATABASE_URL is auto-added by the Postgres plugin)
5.  Backend → Settings → Networking → Generate Domain
6.  Run the migration (Railway CLI):  railway run npm run migrate
7.  Trigger the first sync:
        curl -X POST "https://YOUR-URL/sync/liverpool" -H "x-sync-secret: YOUR_SECRET"
8.  Watch progress:  https://YOUR-URL/sync/status
```

Done. Your API is live with real data.

## ───────── WHAT EACH FILE DOES ─────────

```
src/server.js              → the Express server + routes wiring
src/config/index.js        → loads env vars + city presets
src/db/pool.js             → PostgreSQL connection
src/db/migrate.js          → creates the tables
migrations/001_init.sql    → the database schema (5 tables)

src/clients/google.js      → fetches venues from Google Places
src/clients/foursquare.js  → fetches venues from Foursquare
src/clients/osm.js         → fetches venues from OpenStreetMap
src/clients/skiddle.js     → fetches events from Skiddle
src/clients/eventbrite.js  → fetches events from Eventbrite

src/services/dedup.js      → merges duplicate venues across providers
src/services/matchEvents.js→ links events to the right venue
src/services/sync.js       → runs the whole pipeline

src/routes/venues.js       → GET /venues, GET /venues/:id
src/routes/events.js       → GET /events, GET /events/:id
src/routes/sync.js         → POST /sync/liverpool, /sync/city/:city, /sync/status

src/scripts/preflight.js   → checks your setup before syncing
src/scripts/syncLiverpool.js → one-off Liverpool sync
```
