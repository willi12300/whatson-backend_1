-- 010_background_enrichment.sql
-- Tracks background enrichment for discovered venues.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS facebook TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS socials_checked BOOLEAN DEFAULT FALSE;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS socials_last_checked TIMESTAMPTZ;

ALTER TABLE venues ADD COLUMN IF NOT EXISTS enrichment_status TEXT DEFAULT 'new';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS enrichment_requested_at TIMESTAMPTZ;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS enrichment_last_completed_at TIMESTAMPTZ;

ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_status TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_debug JSONB;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS tripadvisor_candidates JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_venues_enrichment_status ON venues(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_venues_socials_checked ON venues(socials_checked);
