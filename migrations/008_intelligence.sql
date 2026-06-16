-- 008_intelligence.sql
-- Roulette anti-repetition history + venue/event intelligence (cache) layer.

-- ── Roulette spin history (anti-repetition) ──
CREATE TABLE IF NOT EXISTS roulette_history (
  id           SERIAL PRIMARY KEY,
  device_id    TEXT,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  result_key   TEXT NOT NULL,          -- stable id of the chosen result (venue/event)
  result_name  TEXT,
  shown_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roulette_hist_device ON roulette_history(device_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_roulette_hist_user ON roulette_history(user_id, shown_at DESC);

-- ── Venue intelligence (Sappo's own growing knowledge base) ──
-- Mirrors discovered venues from any source so we depend less on live calls over time.
CREATE TABLE IF NOT EXISTS venue_intelligence (
  id            SERIAL PRIMARY KEY,
  source_key    TEXT UNIQUE,           -- e.g. 'google:ChIJ...' — dedupe across discoveries
  name          TEXT NOT NULL,
  category      TEXT,
  subcategory   TEXT,
  description   TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  address       TEXT,
  rating        REAL,
  rating_count  INTEGER,
  opening_hours JSONB,
  website       TEXT,
  image_url     TEXT,
  ticket_url    TEXT,
  sources       TEXT[],                -- which providers have seen this
  -- user intelligence (future-proofing: learn what people like)
  times_shown   INTEGER NOT NULL DEFAULT 0,
  times_clicked INTEGER NOT NULL DEFAULT 0,
  times_chosen  INTEGER NOT NULL DEFAULT 0,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venue_intel_geo ON venue_intelligence(lat, lng);

-- ── Event intelligence (cached events from all providers) ──
CREATE TABLE IF NOT EXISTS event_intelligence (
  id            SERIAL PRIMARY KEY,
  source_key    TEXT UNIQUE,           -- 'skiddle:123' / 'ticketmaster:abc'
  title         TEXT NOT NULL,
  venue_name    TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  address       TEXT,
  starts_at     TIMESTAMPTZ,
  category      TEXT,
  genre         TEXT,
  ticket_url    TEXT,
  image_url     TEXT,
  is_free       BOOLEAN,
  min_price     REAL,
  source        TEXT,                  -- skiddle | ticketmaster | eventbrite
  times_shown   INTEGER NOT NULL DEFAULT 0,
  times_chosen  INTEGER NOT NULL DEFAULT 0,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_intel_starts ON event_intelligence(starts_at);
