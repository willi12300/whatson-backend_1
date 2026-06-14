-- migrations/003_users_auth.sql
-- Real user accounts via Google login, plus linking device progress to users.

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  google_id   TEXT UNIQUE NOT NULL,
  name        TEXT,
  email       TEXT,
  avatar_url  TEXT,
  xp          INTEGER DEFAULT 0,
  level       INTEGER DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_google ON users(google_id);

-- Link existing device-based tables to a user once they log in.
-- (We keep device_id columns so pre-login progress can be claimed.)
ALTER TABLE check_ins          ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE badges             ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE challenge_progress ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Saved plans (night plans a user keeps)
CREATE TABLE IF NOT EXISTS saved_plans (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT,
  city       TEXT,
  plan       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_plans_user ON saved_plans(user_id);
