-- 014_gem_tags.sql
-- Durable "gem tags" derived from review text (hidden_gem, local_favourite,
-- romantic, great_cocktails, …). We store ONLY the derived tags + metadata,
-- never the raw review text.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS gem_tags JSONB DEFAULT '[]'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS gem_cautions JSONB DEFAULT '[]'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS gem_tags_checked TIMESTAMPTZ;

-- Index so roulette can cheaply prefer/inspect tagged venues if needed later.
CREATE INDEX IF NOT EXISTS idx_venues_gem_tags ON venues USING gin (gem_tags);
