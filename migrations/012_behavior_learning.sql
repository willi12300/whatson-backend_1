-- 012_behavior_learning.sql
-- Lightweight SAPPO learning layer. Tracks user/global behaviour signals so recommendations
-- can learn without heavy ML.

CREATE TABLE IF NOT EXISTS user_interactions (
  id              SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id        TEXT,
  item_type        TEXT NOT NULL DEFAULT 'venue', -- venue | event | plan
  item_id          TEXT,
  venue_id         INTEGER REFERENCES venues(id) ON DELETE SET NULL,
  event_id         INTEGER REFERENCES events(id) ON DELETE SET NULL,
  item_name        TEXT,
  action           TEXT NOT NULL, -- shown | clicked | opened_profile | added_to_plan | saved | shared | directions | dismissed | ignored
  category_slug    TEXT,
  city             TEXT,
  source           TEXT,
  context          TEXT, -- ai | roulette | explore | plan | profile | nearby
  metadata         JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_interactions_user_recent ON user_interactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_interactions_device_recent ON user_interactions(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_interactions_venue_action ON user_interactions(venue_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_interactions_event_action ON user_interactions(event_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_interactions_city_cat ON user_interactions(city, category_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS user_preference_signals (
  id              SERIAL PRIMARY KEY,
  owner_key       TEXT NOT NULL, -- user:123 or device:abc
  signal_key      TEXT NOT NULL, -- category:restaurant, city:Liverpool, source:google, context:roulette
  signal_value    REAL NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_key, signal_key)
);
CREATE INDEX IF NOT EXISTS idx_user_preference_owner ON user_preference_signals(owner_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS venue_popularity_signals (
  venue_id         INTEGER PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  times_shown      INTEGER NOT NULL DEFAULT 0,
  times_clicked    INTEGER NOT NULL DEFAULT 0,
  times_opened     INTEGER NOT NULL DEFAULT 0,
  times_added      INTEGER NOT NULL DEFAULT 0,
  times_saved      INTEGER NOT NULL DEFAULT 0,
  times_shared     INTEGER NOT NULL DEFAULT 0,
  times_directions INTEGER NOT NULL DEFAULT 0,
  times_dismissed  INTEGER NOT NULL DEFAULT 0,
  last_interaction_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS event_popularity_signals (
  event_id         INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  times_shown      INTEGER NOT NULL DEFAULT 0,
  times_clicked    INTEGER NOT NULL DEFAULT 0,
  times_opened     INTEGER NOT NULL DEFAULT 0,
  times_added      INTEGER NOT NULL DEFAULT 0,
  times_saved      INTEGER NOT NULL DEFAULT 0,
  times_shared     INTEGER NOT NULL DEFAULT 0,
  times_directions INTEGER NOT NULL DEFAULT 0,
  times_dismissed  INTEGER NOT NULL DEFAULT 0,
  last_interaction_at TIMESTAMPTZ
);
