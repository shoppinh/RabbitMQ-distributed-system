-- Inventory Service Database Schema
-- Initial migration for inventory_db

-- Inventory reservations table (local state)
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id UUID PRIMARY KEY,
  saga_id UUID NOT NULL,
  order_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'failed')),
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  reserved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Outbox events table for Inventory Service
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  routing_key TEXT NOT NULL,
  saga_id UUID,
  correlation_id UUID,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

-- Idempotency protection for processed events
CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_unpublished_created_at
  ON events (created_at)
  WHERE published = FALSE;

CREATE INDEX IF NOT EXISTS idx_inventory_saga_id
  ON inventory_reservations (saga_id);

CREATE INDEX IF NOT EXISTS idx_inventory_order_id
  ON inventory_reservations (order_id);

CREATE INDEX IF NOT EXISTS idx_processed_events_at
  ON processed_events (processed_at);
