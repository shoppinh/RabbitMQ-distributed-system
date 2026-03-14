-- Update inventory_reservations status to allow released and committed

ALTER TABLE inventory_reservations DROP CONSTRAINT IF EXISTS inventory_reservations_status_check;
ALTER TABLE inventory_reservations ADD CONSTRAINT inventory_reservations_status_check CHECK (status IN ('pending', 'reserved', 'failed', 'released', 'committed'));
ALTER TABLE inventory_reservations ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour';
ALTER TABLE inventory_reservations ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE inventory_reservations ADD COLUMN release_at TIMESTAMPTZ;

-- Remove items column and add per-sku columns
ALTER TABLE inventory_reservations DROP COLUMN IF EXISTS items;
ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS sku VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 0;