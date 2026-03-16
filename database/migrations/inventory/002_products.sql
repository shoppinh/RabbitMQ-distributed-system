-- Inventory Service Database Schema: 002_products.sql
-- Implements products, prices, and reservation-based inventory

CREATE TABLE IF NOT EXISTS products (
  sku VARCHAR(50) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_prices (
  id UUID PRIMARY KEY,
  sku VARCHAR(50) NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
  price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  effective_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_prices_sku ON product_prices(sku);

CREATE TABLE IF NOT EXISTS inventory (
  sku VARCHAR(50) PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
  total_stock INTEGER NOT NULL DEFAULT 0,
  reserved_stock INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT chk_stock_reservation CHECK (reserved_stock >= 0 AND total_stock >= reserved_stock)
);

-- Basic sample data
INSERT INTO products (sku, name, description) 
VALUES 
  ('SKU-1', 'Premium Widget', 'High quality widget for all your needs'),
  ('A1', 'Basic Component', 'Standard component A1')
ON CONFLICT (sku) DO NOTHING;

INSERT INTO product_prices (id, sku, price, currency)
SELECT gen_random_uuid(), 'SKU-1', 125.50, 'USD'
WHERE NOT EXISTS (SELECT 1 FROM product_prices WHERE sku = 'SKU-1');

INSERT INTO product_prices (id, sku, price, currency)
SELECT gen_random_uuid(), 'A1', 100.00, 'USD'
WHERE NOT EXISTS (SELECT 1 FROM product_prices WHERE sku = 'A1');

INSERT INTO inventory (sku, total_stock, reserved_stock)
VALUES 
  ('SKU-1', 100, 0),
  ('A1', 50, 0)
ON CONFLICT (sku) DO NOTHING;
