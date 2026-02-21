-- Order Service Database Schema
-- Initial migration for order_db

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  customer_id TEXT,
  customer_email TEXT,
  amount DECIMAL(10,2),
  currency TEXT DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Outbox events table for Order Service
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

-- Saga instances table (Saga orchestration state)
CREATE TABLE IF NOT EXISTS saga_instances (
  saga_id UUID PRIMARY KEY,
  order_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'refunding', 'timeout_cancelled')),
  current_step TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  timeout_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  failure_reason TEXT
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

CREATE INDEX IF NOT EXISTS idx_saga_status_timeout
  ON saga_instances (timeout_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_saga_order_id
  ON saga_instances (order_id);

CREATE INDEX IF NOT EXISTS idx_processed_events_at
  ON processed_events (processed_at);
