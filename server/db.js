'use strict';

const { Pool } = require('pg');
const { DEFAULT_PRODUCTS } = require('./products');

// Idempotent (IF NOT EXISTS), so it is safe to run on every boot.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE,
  phone             TEXT NOT NULL,
  salt              TEXT NOT NULL,
  hash              TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session and one-time tokens are stored as SHA-256 hashes, never in plain text.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  customer_email    TEXT,
  customer_address  TEXT NOT NULL,
  customer_notes    TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled')),
  total             INTEGER NOT NULL CHECK (total >= 0),
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_customer_created ON orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders (status, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  name        TEXT NOT NULL,
  unit_price  INTEGER NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  line_total  INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS order_status_history (
  id        BIGSERIAL PRIMARY KEY,
  order_id  TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status    TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Added after the first release; IF NOT EXISTS keeps existing databases up to date.
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cod';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pay_on_delivery';
`;

function createPool({ connectionString, ssl = false }) {
  return new Pool({
    connectionString,
    max: 10,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    idleTimeoutMillis: 30000,
  });
}

async function migrate(pool) {
  await pool.query(SCHEMA_SQL);
}

/** Inserts the default catalogue if it is missing. Existing products (and their stock) are left alone. */
async function seedProducts(pool, products = DEFAULT_PRODUCTS) {
  for (const p of products) {
    await pool.query(
      `INSERT INTO products (id, name, category, price, stock, description)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.name, p.category, p.price, p.stock, p.description],
    );
  }
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back if it throws. */
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, seedProducts, withTx, SCHEMA_SQL };