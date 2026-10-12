-- Only sourced description excerpts are cached; canonical profiles are untouched.
CREATE TABLE IF NOT EXISTS venue_description_sources (
  venue_id INTEGER PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  source_url TEXT,
  paragraphs JSONB NOT NULL DEFAULT '[]',
  content_hash TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
