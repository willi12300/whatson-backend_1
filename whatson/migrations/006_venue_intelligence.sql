-- migrations/006_venue_intelligence.sql
-- Pricing intelligence, menu fields, and a deals/offers table.

-- Pricing fields on venues (price_level already exists)
ALTER TABLE venues ADD COLUMN IF NOT EXISTS price_range TEXT;            -- e.g. "£10-20"
ALTER TABLE venues ADD COLUMN IF NOT EXISTS average_spend_estimate INTEGER; -- £ per person
ALTER TABLE venues ADD COLUMN IF NOT EXISTS min_price NUMERIC;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS max_price NUMERIC;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'GBP';
ALTER TABLE venues ADD COLUMN IF NOT EXISTS pricing_source TEXT;

-- Menu fields on venues
ALTER TABLE venues ADD COLUMN IF NOT EXISTS menu_url TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS menu_summary TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS cuisine_type TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS dietary_options TEXT;        -- comma list e.g. "veggie,vegan,gf"
ALTER TABLE venues ADD COLUMN IF NOT EXISTS sample_price_range TEXT;     -- e.g. "mains £12-18"

-- Offers / deals
CREATE TABLE IF NOT EXISTS offers (
  id              SERIAL PRIMARY KEY,
  venue_id        INTEGER REFERENCES venues(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  discount_type   TEXT,            -- percentage | fixed | 2for1 | freebie | happy_hour
  estimated_value TEXT,            -- human e.g. "Save ~£8"
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  terms           TEXT,
  source          TEXT DEFAULT 'manual',  -- manual | groupon | eventbrite | venue
  redeem_url      TEXT,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offers_venue ON offers(venue_id);
CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(active);
