# What'sOn Backend — Setup Guide (Beginner Friendly)

This is the real data engine for your venue discovery app. It pulls live data
from Google Places, Foursquare, OpenStreetMap, Skiddle and Eventbrite, cleans
and deduplicates it, and serves it through a simple API.

**You do not need to be a developer to deploy this.** Follow the steps exactly.

---

## What you'll end up with

A live API on the internet with these endpoints:

| Endpoint | What it does |
|---|---|
| `GET /health` | Check the server + database are alive |
| `GET /venues` | List venues (filter by location, category, search) |
| `GET /venues/:id` | One venue's full profile + its events |
| `GET /events` | List upcoming events |
| `GET /events/:id` | One event's details |
| `POST /sync/liverpool` | Pull all Liverpool data from the APIs |
| `POST /sync/city/:city` | Same for manchester or london |
| `GET /sync/status` | See how recent syncs went |

---

## PART A — Test it on your own computer first (optional but recommended)

### 1. Install the tools
- Install **Node.js 18+**: https://nodejs.org (click the big LTS button)
- Install **Docker Desktop**: https://docker.com/products/docker-desktop
  (this runs a local database so you don't have to install Postgres manually)

### 2. Open a terminal in this folder
- Windows: open the folder, type `cmd` in the address bar, press Enter
- Mac: right-click the folder → Services → New Terminal at Folder

### 3. Install dependencies
```
npm install
```

### 4. Start the local database
```
docker-compose up -d
```

### 5. Create your settings file
Copy `.env.example` to a new file called `.env`, then open `.env` and paste in
your real API keys. Leave `DATABASE_URL` as it is for local testing.

### 6. Create the database tables
```
npm run migrate
```
You should see "All migrations complete."

### 7. Pull real Liverpool data
```
npm run sync:liverpool
```
This takes 2–4 minutes and uses ~$2 of your Google free credit.
Watch the logs — you'll see venue and event counts climb.

### 8. Start the server
```
npm run dev
```

### 9. Test it
Open your browser to:
- http://localhost:3000/health
- http://localhost:3000/venues?city=Liverpool&limit=10
- http://localhost:3000/events?city=Liverpool

---

## PART B — Deploy to Railway (so it's live on the internet)

### 1. Put the code on GitHub
- Make a free account at github.com
- Create a new repository called `whatson-backend`
- Upload this whole folder (drag and drop works on GitHub's website,
  or use the commands below in your terminal):

```
git init
git add .
git commit -m "What'sOn backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/whatson-backend.git
git push -u origin main
```

### 2. Create the Railway project
1. Go to **railway.app** and sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo** → pick `whatson-backend`
3. Railway starts building automatically

### 3. Add a PostgreSQL database
1. In your project, click **+ New** → **Database** → **Add PostgreSQL**
2. Railway creates it and a `DATABASE_URL` variable automatically

### 4. Add your environment variables
1. Click your **backend service** (not the database) → **Variables** tab
2. Add each of these (the database URL is usually auto-linked; if not, copy it
   from the Postgres service's Variables tab):

```
GOOGLE_PLACES_API_KEY = your key
FOURSQUARE_API_KEY    = your key
SKIDDLE_API_KEY       = your key
EVENTBRITE_TOKEN      = your token
SYNC_SECRET           = make-up-a-long-random-string
NODE_ENV              = production
```

(You do NOT need to set PORT — Railway handles it. You do NOT need to set
DATABASE_URL if Railway auto-linked the Postgres plugin — check the Variables
tab; if it's missing, copy it from the Postgres service.)

### 5. Create the database tables
1. In Railway, click your backend service → the **⋮** menu → look for a way to
   run a command, OR install the Railway CLI (railway.app/cli) and run:
```
railway run npm run migrate
```
   If you can't run commands, you can temporarily add this to your start command
   then remove it: `npm run migrate && npm start`

### 6. Get your live URL
1. Backend service → **Settings** → **Networking** → **Generate Domain**
2. You'll get something like `https://whatson-backend-production.up.railway.app`
3. Test it: open `https://YOUR-URL/health` — you should see `{"status":"ok",...}`

### 7. Pull the data
Trigger the Liverpool sync. Open a terminal anywhere and run (replace the URL
and secret):
```
curl -X POST "https://YOUR-URL/sync/liverpool" -H "x-sync-secret: YOUR_SYNC_SECRET"
```
Then watch progress at `https://YOUR-URL/sync/status`.

Done! Your API is live with real Liverpool data.

---

## Keeping data fresh (automatic syncs)

In Railway → backend service → **Settings** → **Cron Jobs**, add:

| When | Command |
|---|---|
| `0 3 * * 0` (Sundays 3am) | `npm run sync:liverpool` |

Events update themselves each time a sync runs.

---

## How it works (the short version)

1. **Clients** (`src/clients/`) each talk to one external API and return a
   normalised list of venues or events.
2. **Dedup** (`src/services/dedup.js`) merges the same venue appearing in
   Google + Foursquare + OSM into one clean record, using name similarity,
   distance, and matching phone/website.
3. **Matching** (`src/services/matchEvents.js`) attaches each event to the
   right venue using name + location, creating a stub venue if needed.
4. **Sync** (`src/services/sync.js`) runs the whole pipeline and saves to
   PostgreSQL.
5. **Routes** (`src/routes/`) serve clean JSON to your app. The API keys never
   leave the server.

---

## Troubleshooting

- **/health shows `"db":"down"`** → DATABASE_URL is wrong or the database isn't
  running. On Railway, make sure the Postgres plugin is added and linked.
- **Sync returns 401** → you forgot the `x-sync-secret` header, or it doesn't
  match your `SYNC_SECRET` variable.
- **Google returns 0 venues** → check the key has "Places API (New)" enabled
  and billing is active in Google Cloud Console.
- **Eventbrite returns 0 events** → this is expected for many tokens; Eventbrite
  restricted their public search API. The rest of your data still works.
- **Foursquare 401** → the Authorization header uses your Service Key directly
  (no "Bearer"). Double-check you pasted the Service API key.
