-- 011_google_profiles.sql
-- Tracks Google Places profile enrichment for cached venue profile pages.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_status TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_last_checked TIMESTAMPTZ;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_debug JSONB;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS google_review_sample JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_venues_google_status ON venues(google_status);
CREATE INDEX IF NOT EXISTS idx_venues_google_last_checked ON venues(google_last_checked);
