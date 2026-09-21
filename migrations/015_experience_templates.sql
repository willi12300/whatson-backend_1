-- City-agnostic frameworks. Venue selection happens at request time.
CREATE TABLE IF NOT EXISTS experience_templates (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 240,
  ideal_time JSONB NOT NULL DEFAULT '[]'::jsonb,
  ideal_weather JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget JSONB NOT NULL DEFAULT '[]'::jsonb,
  audience JSONB NOT NULL DEFAULT '[]'::jsonb,
  energy_level TEXT,
  walking_preference TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS experience_template_stops (
  id BIGSERIAL PRIMARY KEY,
  template_id BIGINT NOT NULL REFERENCES experience_templates(id) ON DELETE CASCADE,
  stop_order INTEGER NOT NULL,
  role TEXT NOT NULL,
  venue_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  swappable BOOLEAN NOT NULL DEFAULT TRUE,
  minimum_rating NUMERIC(2,1),
  preferred_budget JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_ambience JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_walking_distance_m INTEGER,
  duration_minutes INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(template_id, stop_order)
);

CREATE TABLE IF NOT EXISTS experience_template_rules (
  id BIGSERIAL PRIMARY KEY,
  template_id BIGINT NOT NULL REFERENCES experience_templates(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  weight NUMERIC(6,2) NOT NULL DEFAULT 1,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(template_id, rule_type, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_experience_template_stops_template ON experience_template_stops(template_id, stop_order);
CREATE INDEX IF NOT EXISTS idx_experience_template_rules_template ON experience_template_rules(template_id);
