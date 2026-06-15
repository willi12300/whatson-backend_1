-- migrations/005_missions_v2.sql
-- Curated missions system (app-created, shown to all users in a city).
-- Evolves the earlier missions tables to match the new spec.

-- Extend missions with type/active/scheduling
ALTER TABLE missions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'permanent';   -- daily|weekly|permanent|featured
ALTER TABLE missions ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS curated BOOLEAN DEFAULT TRUE;

-- Extend mission_stops with task types + descriptions
ALTER TABLE mission_stops ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE mission_stops ADD COLUMN IF NOT EXISTS task_type TEXT DEFAULT 'checkin'; -- checkin|photo|selfie|landmark_photo|food_photo
ALTER TABLE mission_stops ADD COLUMN IF NOT EXISTS required_radius_meters INTEGER DEFAULT 50;
ALTER TABLE mission_stops ADD COLUMN IF NOT EXISTS photo_required BOOLEAN DEFAULT FALSE;

-- user_missions: a user's status on a mission
CREATE TABLE IF NOT EXISTS user_missions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT,
  mission_id   INTEGER REFERENCES missions(id) ON DELETE CASCADE,
  status       TEXT DEFAULT 'in_progress',  -- not_started|in_progress|completed
  started_at   TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  xp_awarded   INTEGER DEFAULT 0,
  UNIQUE (device_id, mission_id)
);
CREATE INDEX IF NOT EXISTS idx_usermissions_device ON user_missions(device_id);
CREATE INDEX IF NOT EXISTS idx_usermissions_user ON user_missions(user_id);

-- mission_checkins: a verified check-in at a mission stop
CREATE TABLE IF NOT EXISTS mission_checkins (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id           TEXT,
  mission_id          INTEGER REFERENCES missions(id) ON DELETE CASCADE,
  mission_stop_id     INTEGER REFERENCES mission_stops(id) ON DELETE CASCADE,
  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,
  accuracy            DOUBLE PRECISION,
  photo_url           TEXT,
  verified            BOOLEAN DEFAULT FALSE,
  verification_method TEXT,   -- gps | gps_photo | ai_photo
  created_at          TIMESTAMPTZ DEFAULT now(),
  UNIQUE (device_id, mission_stop_id)
);
CREATE INDEX IF NOT EXISTS idx_mcheckins_device ON mission_checkins(device_id);

-- user_badges: badges earned from missions
CREATE TABLE IF NOT EXISTS user_badges (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT,
  badge_name  TEXT NOT NULL,
  mission_id  INTEGER REFERENCES missions(id) ON DELETE SET NULL,
  awarded_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (device_id, badge_name)
);
CREATE INDEX IF NOT EXISTS idx_userbadges_device ON user_badges(device_id);
