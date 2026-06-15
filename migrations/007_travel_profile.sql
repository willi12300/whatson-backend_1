-- 007_travel_profile.sql
-- Sappo traveller personality system. Profiles are keyed by user_id (when logged in)
-- OR device_id (anonymous). One of the two is always present.

CREATE TABLE IF NOT EXISTS user_travel_profile (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id          TEXT,

  -- archetype scores (0+, start at 0)
  explorer_score     INTEGER NOT NULL DEFAULT 0,
  foodie_score       INTEGER NOT NULL DEFAULT 0,
  night_owl_score    INTEGER NOT NULL DEFAULT 0,
  culture_score      INTEGER NOT NULL DEFAULT 0,
  nature_score       INTEGER NOT NULL DEFAULT 0,
  chill_score        INTEGER NOT NULL DEFAULT 0,
  adventurer_score   INTEGER NOT NULL DEFAULT 0,
  romantic_score     INTEGER NOT NULL DEFAULT 0,
  family_score       INTEGER NOT NULL DEFAULT 0,
  budget_score       INTEGER NOT NULL DEFAULT 0,

  -- tolerances (start neutral at 50, range clamped 0-100)
  walking_tolerance  INTEGER NOT NULL DEFAULT 50,
  crowd_tolerance    INTEGER NOT NULL DEFAULT 50,
  price_sensitivity  INTEGER NOT NULL DEFAULT 50,

  last_updated       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one profile per user, and one per device (for anonymous users)
CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_profile_user
  ON user_travel_profile(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_profile_device
  ON user_travel_profile(device_id) WHERE device_id IS NOT NULL AND user_id IS NULL;
