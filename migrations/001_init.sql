CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS categories (
  id    SERIAL PRIMARY KEY,
  slug  TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  icon  TEXT,
  color TEXT
);

INSERT INTO categories (slug, label, icon, color) VALUES
  ('pub',         'Pub',        '🍺', '#FFA502'),
  ('bar',         'Bar',        '🍸', '#FF5E57'),
  ('nightclub',   'Club',       '🎧', '#6C5CE7'),
  ('restaurant',  'Restaurant', '🍽️', '#00cec9'),
  ('cafe',        'Café',       '☕', '#2ED573'),
  ('music_venue', 'Live Music', '🎵', '#e84393'),
  ('comedy_club', 'Comedy',     '😂', '#FFA502'),
  ('karaoke',     'Karaoke',    '🎤', '#a29bfe'),
  ('other',       'Other',      '📍', '#9B9BA8')
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS venues (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  normalised_name TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_venues_city     ON venues(city);
CREATE INDEX IF NOT EXISTS idx_venues_category ON venues(category_slug);
CREATE INDEX IF NOT EXISTS idx_venues_latlng   ON venues(lat, lng);
CREATE INDEX IF NOT EXISTS idx_venues_name_trgm ON venues USING gin (normalised_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS venue_sources (
  id          SERIAL PRIMARY KEY,
  venue_id    INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  raw         JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS events (
  id               SERIAL PRIMARY KEY,
  venue_id         INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  image_url        TEXT,
  category         TEXT,
  genre            TEXT,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ,
  is_free          BOOLEAN DEFAULT FALSE,
  min_price        REAL,
  ticket_url       TEXT,
  raw_venue_name   TEXT,
  raw_address      TEXT,
  match_confidence REAL,
  status           TEXT DEFAULT 'active',
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_venue  ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS event_sources (
  id          SERIAL PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  raw         JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id              SERIAL PRIMARY KEY,
  city            TEXT,
  started_at      TIMESTAMPTZ DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  venues_added    INTEGER DEFAULT 0,
  venues_updated  INTEGER DEFAULT 0,
  events_added    INTEGER DEFAULT 0,
  events_updated  INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'running',
  error           TEXT
);
