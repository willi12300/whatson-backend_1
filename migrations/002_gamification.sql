-- migrations/002_gamification.sql
-- Check-ins, rewards (XP/badges), and challenges/missions storage.
-- Uses a simple device_id for the MVP (no auth yet) so progress persists per device.

CREATE TABLE IF NOT EXISTS check_ins (
  id           SERIAL PRIMARY KEY,
  device_id    TEXT NOT NULL,
  venue_id     INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  challenge_id INTEGER,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  gps_verified BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkins_device ON check_ins(device_id);
CREATE INDEX IF NOT EXISTS idx_checkins_venue  ON check_ins(venue_id);

-- A user's running profile (XP, level) keyed by device for now
CREATE TABLE IF NOT EXISTS profiles (
  device_id    TEXT PRIMARY KEY,
  xp           INTEGER DEFAULT 0,
  level        INTEGER DEFAULT 1,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Badges earned
CREATE TABLE IF NOT EXISTS badges (
  id          SERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL,
  badge_key   TEXT NOT NULL,
  label       TEXT NOT NULL,
  earned_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (device_id, badge_key)
);
CREATE INDEX IF NOT EXISTS idx_badges_device ON badges(device_id);

-- Challenges/missions (generated, stored so progress can be tracked)
CREATE TABLE IF NOT EXISTS challenges (
  id          SERIAL PRIMARY KEY,
  city        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  reward_xp   INTEGER DEFAULT 100,
  reward_badge TEXT,
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{venueId, label}] or rule-based
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_challenges_city ON challenges(city);

-- A device's progress on a challenge
CREATE TABLE IF NOT EXISTS challenge_progress (
  id           SERIAL PRIMARY KEY,
  device_id    TEXT NOT NULL,
  challenge_id INTEGER REFERENCES challenges(id) ON DELETE CASCADE,
  completed_steps JSONB DEFAULT '[]'::jsonb,
  completed    BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (device_id, challenge_id)
);
CREATE INDEX IF NOT EXISTS idx_chalprog_device ON challenge_progress(device_id);
