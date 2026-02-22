-- Payment Service Database Schema
-- Initial migration for payment_db

-- Payment transactions table (local state)
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  saga_id UUID NOT NULL,
  order_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'refunding', 'refunded')),
  amount DECIMAL(10,2),
  currency TEXT DEFAULT 'USD',
  processed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Outbox events table for Payment Service
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  routing_key TEXT NOT NULL,
  saga_id UUID,
  -- Optional request/trace identifier. Can be reused across multiple sagas.
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

CREATE INDEX IF NOT EXISTS idx_payment_saga_id
  ON payment_transactions (saga_id);

CREATE INDEX IF NOT EXISTS idx_payment_order_id
  ON payment_transactions (order_id);

CREATE INDEX IF NOT EXISTS idx_processed_events_at
  ON processed_events (processed_at);
