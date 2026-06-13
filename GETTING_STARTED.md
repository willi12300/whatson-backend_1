# Getting Started — What'sOn Backend

## Prerequisites
- Node.js 20+
- Docker Desktop (for local Postgres + Redis)
- Your API keys (see .env.example)

---

## Step 1: Clone and install

```bash
cd whatson-backend
npm install
```

---

## Step 2: Set up environment

```bash
cp .env.example .env
# Edit .env and add your API keys
```

---

## Step 3: Start local database

```bash
docker-compose up -d
# Postgres on :5432, Redis on :6379
```

---

## Step 4: Run database migrations

```bash
npm run db:generate   # generates Prisma client from schema
npm run db:migrate    # creates all tables in Postgres
```

If the migration asks for a name, call it `init`.

This enables these Postgres extensions automatically:
- `postgis` — geospatial queries
- `pg_trgm` — fuzzy text search (used in venue search + event matching)
- `unaccent` — accent-insensitive search

---

## Step 5: Run first venue ingestion

This seeds your database with real Liverpool venues from all three sources.
**Warning:** this will use ~60 Google Places API calls (~$1.92 of your free credit).

```bash
npm run ingest:venues
```

Watch the logs. You should see:
```
Starting Google Places grid scan
Starting Foursquare scan
OSM scan complete { count: 847 }
Venue deduplication complete { total: 2341, unique: 892, dupes: 1449 }
Venue ingestion complete { created: 892, updated: 0 }
```

---

## Step 6: Run event ingestion

```bash
npm run ingest:events
```

---

## Step 7: Start the API server

```bash
npm run dev
```

Test it:
```bash
curl "http://localhost:3000/health"
curl "http://localhost:3000/api/v1/venues/nearby?lat=53.4084&lng=-2.9916&radius=1000"
curl "http://localhost:3000/api/v1/feed?lat=53.4084&lng=-2.9916"
```

---

## Step 8: Explore the database

```bash
npm run db:studio
# Opens Prisma Studio at http://localhost:5555 — visual DB browser
```

---

## Deploying to Railway.app

1. Push code to GitHub
2. New project on railway.app → deploy from GitHub
3. Add Postgres plugin → add Redis plugin
4. Set all env vars in Railway dashboard
5. Add start command: `npm run build && npm start`
6. Set up cron jobs in Railway for ingestion:
   - `npm run ingest:venues` → weekly
   - `npm run ingest:events` → every 4 hours

---

## API Reference

### Public endpoints (no auth)
```
GET /health
GET /api/v1/venues/nearby?lat=&lng=&radius=&type=&limit=
GET /api/v1/venues/search?q=&city=
GET /api/v1/venues/:id
GET /api/v1/feed?lat=&lng=&radius=&filter=
```

### Authenticated endpoints (Bearer token)
```
POST /api/v1/offers/:id/claim
GET  /api/v1/offers/claims/:claimId/qr
POST /api/v1/offers/redeem          (staff scanner)
```

---

## Next files to build (not in this package)

1. `src/api/checkins.ts` — POST /checkins, GET /venues/:id/checkins
2. `src/api/vibeReports.ts` — POST /vibe-reports
3. `src/api/community.ts` — community posts CRUD
4. `src/api/venueAdmin.ts` — claim flow, post composer, offer creation
5. `src/api/analytics.ts` — venue dashboard stats
6. `src/jobs/queue.ts` — BullMQ scheduled job setup
7. `src/ingestion/ticketmaster.ts` — same pattern as skiddle.ts

---

## Architecture diagram

```
Frontend (React Native app)
    │
    │  HTTPS — only talks to YOUR API
    ▼
API Server (Fastify/Node.js)
    │
    ├── PostgreSQL + PostGIS   ← all venue/event data lives here
    ├── Redis                  ← cache + QR token locks
    │
    └── Background Jobs (BullMQ)
            │
            ├── Google Places API    ┐
            ├── Foursquare API       ├── venue data (weekly)
            ├── OpenStreetMap        ┘
            │
            ├── Skiddle API          ┐
            ├── Eventbrite API       ├── event data (4-hourly)
            └── Ticketmaster API     ┘

API keys NEVER leave the server. Frontend gets clean JSON only.
```
