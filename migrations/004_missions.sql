-- migrations/004_missions.sql
-- Full missions system: missions, their stops, and per-user progress.

CREATE TABLE IF NOT EXISTS missions (
  id                 SERIAL PRIMARY KEY,
  city               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  category           TEXT,
  theme              TEXT,
  difficulty         TEXT DEFAULT 'easy',     -- easy | medium | hard
  estimated_duration TEXT,                    -- e.g. 'half_day', '2-3 hours'
  reward_xp          INTEGER DEFAULT 200,
  badge_name         TEXT,
  badge_key          TEXT,
  generated          BOOLEAN DEFAULT TRUE,    -- AI-generated vs hand-made
  created_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_missions_city ON missions(city);

CREATE TABLE IF NOT EXISTS mission_stops (
  id            SERIAL PRIMARY KEY,
  mission_id    INTEGER REFERENCES missions(id) ON DELETE CASCADE,
  venue_id      INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  stop_order    INTEGER NOT NULL,
  title         TEXT,                  -- name of the place/stop
  task          TEXT,                  -- what to do here
  photo_prompt  TEXT,                  -- optional selfie/photo suggestion
  checkin_radius_m INTEGER DEFAULT 50,
  estimated_time   TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_mstops_mission ON mission_stops(mission_id);

-- Per-user (device for now) progress on a mission
CREATE TABLE IF NOT EXISTS mission_progress (
  id              SERIAL PRIMARY KEY,
  device_id       TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  mission_id      INTEGER REFERENCES missions(id) ON DELETE CASCADE,
  completed_stops JSONB DEFAULT '[]'::jsonb,   -- array of mission_stop ids
  started         BOOLEAN DEFAULT TRUE,
  completed       BOOLEAN DEFAULT FALSE,
  started_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  UNIQUE (device_id, mission_id)
);
CREATE INDEX IF NOT EXISTS idx_mprog_device ON mission_progress(device_id);
