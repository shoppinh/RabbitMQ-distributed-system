-- Notification Service Database Schema
-- Initial migration for notification_db

-- Notifications log table (local state)
CREATE TABLE IF NOT EXISTS notifications_log (
  id UUID PRIMARY KEY,
  saga_id UUID NOT NULL,
  order_id UUID NOT NULL,
  type TEXT NOT NULL,
  recipient_email TEXT,
  subject TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
CREATE INDEX IF NOT EXISTS idx_notifications_saga_id
  ON notifications_log (saga_id);

CREATE INDEX IF NOT EXISTS idx_notifications_order_id
  ON notifications_log (order_id);

CREATE INDEX IF NOT EXISTS idx_processed_events_at_notif
  ON processed_events (processed_at);
