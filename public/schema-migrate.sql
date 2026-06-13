-- Migration: add destination columns, fare_lbp now unused (kept for backward compat)
ALTER TABLE rides ADD COLUMN IF NOT EXISTS dest_lat DOUBLE PRECISION;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS dest_lng DOUBLE PRECISION;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS dest_address TEXT;
