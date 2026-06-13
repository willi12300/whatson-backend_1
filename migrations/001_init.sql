-- migrations/001_init.sql
-- What'sOn database schema. Plain PostgreSQL — no PostGIS required.
-- Geo queries use lat/lng with a bounding-box + haversine approach.

-- pg_trgm powers fuzzy text search for venue name matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────
-- categories
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  icon        TEXT,
  color       TEXT
);

INSERT INTO categories (slug, label, icon, color) VALUES
  ('pub',         'Pub',         '🍺', '#FFA502'),
  ('bar',         'Bar',         '🍸', '#FF5E57'),
  ('nightclub',   'Club',        '🎧', '#6C5CE7'),
  ('restaurant',  'Restaurant',  '🍽️', '#00cec9'),
  ('cafe',        'Café',        '☕', '#2ED573'),
  ('comedy_club', 'Comedy',      '😂', '#FFA502'),
  ('music_venue', 'Live Music',  '🎵', '#e84393'),
  ('karaoke',     'Karaoke',     '🎤', '#a29bfe'),
  ('other',       'Other',       '📍', '#9B9BA8')
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────
-- venues  (canonical, deduplicated records)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venues (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  normalised_name TEXT NOT NULL,           -- for fuzzy matching
  category_slug   TEXT REFERENCES categories(slug) DEFAULT 'other',

  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  address         TEXT,
  city            TEXT NOT NULL DEFAULT 'Liverpool',
  postcode        TEXT,
  country         TEXT DEFAULT 'GB',

  phone           TEXT,
  website         TEXT,
  rating          REAL,
  rating_count    INTEGER,
  price_level     INTEGER,
  opening_hours   JSONB,
  business_status TEXT,
  photos          JSONB DEFAULT '[]'::jsonb,
  cover_photo     TEXT,

  claimed         BOOLEAN DEFAULT FALSE,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venues_city        ON venues(city);
CREATE INDEX IF NOT EXISTS idx_venues_category    ON venues(category_slug);
CREATE INDEX IF NOT EXISTS idx_venues_latlng      ON venues(lat, lng);
CREATE INDEX IF NOT EXISTS idx_venues_name_trgm   ON venues USING gin (normalised_name gin_trgm_ops);

-- ─────────────────────────────────────────────
-- venue_sources  (which provider each venue came from)
-- One venue can have many source rows (google + foursquare + osm).
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venue_sources (
  id          SERIAL PRIMARY KEY,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,               -- 'google' | 'foursquare' | 'osm'
  provider_id TEXT NOT NULL,               -- the ID in that provider's system
  raw         JSONB,                       -- raw payload for debugging
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_venue_sources_venue ON venue_sources(venue_id);

-- ─────────────────────────────────────────────
-- events
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id                SERIAL PRIMARY KEY,
  venue_id          INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  image_url         TEXT,
  category          TEXT,
  genre             TEXT,

  starts_at         TIMESTAMPTZ NOT NULL,
  ends_at           TIMESTAMPTZ,

  is_free           BOOLEAN DEFAULT FALSE,
  min_price         REAL,
  ticket_url        TEXT,

  -- store original venue text from the source for matching/debugging
  raw_venue_name    TEXT,
  raw_address       TEXT,
  match_confidence  REAL,

  status            TEXT DEFAULT 'active', -- active | expired | cancelled

  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_venue    ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_starts   ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_status   ON events(status);

-- ─────────────────────────────────────────────
-- event_sources
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_sources (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,               -- 'skiddle' | 'eventbrite'
  provider_id TEXT NOT NULL,
  raw         JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_event_sources_event ON event_sources(event_id);

-- ─────────────────────────────────────────────
-- sync_log  (track ingestion runs)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_log (
  id            SERIAL PRIMARY KEY,
  city          TEXT,
  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  venues_added  INTEGER DEFAULT 0,
  venues_updated INTEGER DEFAULT 0,
  events_added  INTEGER DEFAULT 0,
  events_updated INTEGER DEFAULT 0,
  status        TEXT DEFAULT 'running',     -- running | done | error
  error         TEXT
);
