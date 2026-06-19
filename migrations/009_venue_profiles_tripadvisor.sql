-- 009_venue_profiles_tripadvisor.sql
-- Adds profile/trust fields used by the SAPPO venue profile UX.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_place_id TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_maps_url TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_review_sample JSONB DEFAULT '[]'::jsonb;

ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_location_id TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_rating REAL;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_review_count INTEGER;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_ranking TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_url TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_top_review JSONB;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_last_checked TIMESTAMPTZ;

ALTER TABLE venues ADD COLUMN IF NOT EXISTS profile_last_enriched TIMESTAMPTZ;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS busy_level TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS busy_reason TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS vibe_tags JSONB DEFAULT '[]'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS sappo_score INTEGER;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS why_chosen JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_venues_google_place_id ON venues(google_place_id);
CREATE INDEX IF NOT EXISTS idx_venues_tripadvisor_location_id ON venues(tripadvisor_location_id);
