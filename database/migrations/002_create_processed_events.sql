CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID PRIMARY KEY,
  service_name TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_events_service_processed_at
  ON processed_events (service_name, processed_at DESC);
