-- Keep original IDs resolvable and retain full pre-merge records for recovery.
CREATE TABLE IF NOT EXISTS venue_aliases (
  duplicate_id INTEGER PRIMARY KEY,
  canonical_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  original_name TEXT NOT NULL,
  original_lat DOUBLE PRECISION,
  original_lng DOUBLE PRECISION,
  original_address TEXT,
  original_category TEXT,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (duplicate_id <> canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_venue_aliases_canonical ON venue_aliases(canonical_id);
CREATE TABLE IF NOT EXISTS venue_merge_archive (
  duplicate_id INTEGER PRIMARY KEY,
  canonical_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  canonical_before JSONB NOT NULL,
  duplicate_before JSONB NOT NULL,
  related_before JSONB NOT NULL DEFAULT '{}'::jsonb,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
