-- Payment Service Database Schema: 002_wallets.sql
-- Implements customer wallets for realistic payment processing

CREATE TABLE IF NOT EXISTS customer_wallets (
  customer_id VARCHAR(50) PRIMARY KEY,
  balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_balance CHECK (balance >= 0)
);

-- Add customer_id to payment_transactions for refund tracking
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS customer_id VARCHAR(50);

-- Seed some initial customers
INSERT INTO customer_wallets (customer_id, balance, currency)
VALUES 
  ('cust-1001', 500.00, 'USD'),
  ('cust-1002', 1000.00, 'USD'),
  ('cust-1003', 50.00, 'USD')
ON CONFLICT (customer_id) DO NOTHING;
