-- Wasselni Database Schema
-- Run this in your Supabase SQL Editor

-- Users (riders and drivers)
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  banned BOOLEAN DEFAULT FALSE
);

-- Sessions (persistent login)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  phone TEXT REFERENCES users(phone) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drivers state (online/offline + GPS)
CREATE TABLE IF NOT EXISTS drivers (
  phone TEXT PRIMARY KEY REFERENCES users(phone) ON DELETE CASCADE,
  name TEXT NOT NULL,
  online BOOLEAN DEFAULT FALSE,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  last_gps TIMESTAMPTZ,
  push_endpoint TEXT,
  push_p256dh TEXT,
  push_auth TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Rides (active + history)
CREATE TABLE IF NOT EXISTS rides (
  id TEXT PRIMARY KEY,
  rider_phone TEXT NOT NULL,
  rider_name TEXT,
  rider_lat DOUBLE PRECISION NOT NULL,
  rider_lng DOUBLE PRECISION NOT NULL,
  ride_type TEXT DEFAULT 'ride',
  status TEXT DEFAULT 'pending',
  driver_phone TEXT,
  driver_name TEXT,
  driver_lat DOUBLE PRECISION,
  driver_lng DOUBLE PRECISION,
  fare_lbp INTEGER,
  pinged_drivers JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_sessions_phone ON sessions(phone);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_rider ON rides(rider_phone);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_phone);
CREATE INDEX IF NOT EXISTS idx_drivers_online ON drivers(online);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rides_updated_at BEFORE UPDATE ON rides
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER drivers_updated_at BEFORE UPDATE ON drivers
FOR EACH ROW EXECUTE FUNCTION update_updated_at();
