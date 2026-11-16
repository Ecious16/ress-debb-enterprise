'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createPool, migrate, seedProducts } = require('../server/db');
const { createApp } = require('../server/app');
const { DEFAULT_PRODUCTS } = require('../server/products');

// Tests TRUNCATE every table. Only TEST_DATABASE_URL is read, never DATABASE_URL, so they cannot wipe production by accident.
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database (not production).');
}

const ADMIN = 'test-admin-token-123456789012345678901234';
const LIMITS_OFF = {
  orderCreate: { max: 1000, windowMs: 60000 },
  orderCancel: { max: 1000, windowMs: 60000 },
  orderLookup: { max: 1000, windowMs: 60000 },
  auth: { max: 1000, windowMs: 60000 },
};

let pool;
let app;
let base;
const sent = [];
const mailer = { send: async (msg) => { sent.push(msg); } };

async function resetDb() {
  await pool.query(
    'TRUNCATE idempotency_keys, order_status_history, order_items, orders, auth_tokens, sessions, users, products RESTART IDENTITY CASCADE',
  );
  await seedProducts(pool, DEFAULT_PRODUCTS);
}

async function start(options = {}) {
  app = createApp({
    pool,
    mailer,
    adminToken: ADMIN,
    appUrl: 'http://test.local',
    bankDetails: 'Bank: Test Bank\nAccount: 0123456789\nName: Ress - Debb',
    limits: LIMITS_OFF,
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}

async function call(method, path, { body, token, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data, headers: res.headers };
}

const adminHeaders = { Authorization: `Bearer ${ADMIN}` };

const validCustomer = (overrides = {}) => ({
  name: 'Amina Bello',
  phone: '08012345678',
  email: 'amina@example.com',
  address: '12 Marina Road, Lagos',
  notes: '',
  ...overrides,
});

const stockOf = async (id) => (await pool.query('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock;

let emailCounter = 0;
const uniqueEmail = () => `user${Date.now()}${emailCounter++}@example.com`;

/** Signs up, follows the verification link from the email, and returns a logged-in token. */
async function registerAndLogin(email = uniqueEmail(), password = 'longenough1') {
  const signup = await call('POST', '/api/auth/signup', {
    body: { name: 'Test Customer', email, phone: '08098765432', password },
  });
  assert.equal(signup.status, 201);
  const token = sent.at(-1).text.match(/verify=([a-f0-9]{64})/)[1];
  assert.equal((await call('POST', '/api/auth/verify-email', { body: { token } })).status, 200);
  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return login.data.token;
}

before(async () => {
  // Set TEST_DATABASE_SSL=true for Neon (it requires TLS).
  pool = createPool({ connectionString: TEST_DB, ssl: process.env.TEST_DATABASE_SSL === 'true' });
  await migrate(pool);
  await resetDb();
  await start();
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await pool.end();
});

// ---------- Level 1: catalogue and ordering ----------

test('lists products with prices, categories and stock status', async () => {
  const { status, data } = await call('GET', '/api/products');
  assert.equal(status, 200);
  assert.ok(data.products.length >= 5);
  const p = data.products.find((x) => x.id === 'P-001');
  assert.equal(p.stockStatus, 'in');
  assert.equal(typeof p.price, 'number');
});

test('products with zero stock are hidden from the shop but still listed for admins', async () => {
  const shop = await call('GET', '/api/products');
  assert.equal(shop.data.products.find((x) => x.id === 'P-009'), undefined);
  const admin = await call('GET', '/api/admin/products', { headers: adminHeaders });
  const p = admin.data.products.find((x) => x.id === 'P-009');
  assert.equal(p.stock, 0);
  assert.equal(p.stockStatus, 'out');
});

test('search and category filter narrow the catalogue', async () => {
  const { data } = await call('GET', '/api/products?category=Electronics&q=mouse');
  assert.deepEqual(data.products.map((p) => p.id), ['P-001']);
  const none = await call('GET', '/api/products?category=Packaging&q=tape');
  assert.deepEqual(none.data.products, []); // tape is out of stock, so hidden
});

test('places an order, reserves stock and returns a six-digit RDE Order ID', async () => {
  const before = await stockOf('P-001');
  const { status, data } = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-001', quantity: 2 }] },
  });
  assert.equal(status, 201);
  assert.match(data.order.id, /^RDE-\d{6}$/);
  assert.equal(data.order.status, 'Pending');
  assert.equal(data.order.total, 2 * 8500);
  assert.equal(await stockOf('P-001'), before - 2);

  const lookup = await call('GET', `/api/orders/${data.order.id.toLowerCase()}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.order.id, data.order.id);
  // Public lookup must not leak contact or address details.
  assert.equal(lookup.data.order.customer, undefined);
  assert.equal(lookup.data.order.customerFirstName, 'Amina');
});

test('unknown Order ID returns 404', async () => {
  const { status } = await call('GET', '/api/orders/RDE-000000');
  assert.equal(status, 404);
});

// ---------- Level 2: validation and accounts ----------

test('rejects empty carts, bad quantities, missing details and malformed contacts', async () => {
  const cases = [
    { items: [], customer: validCustomer() },
    { items: [{ productId: 'P-001', quantity: 0 }], customer: validCustomer() },
    { items: [{ productId: 'P-001', quantity: -1 }], customer: validCustomer() },
    { items: [{ productId: 'P-001', quantity: 1.5 }], customer: validCustomer() },
    { items: [{ productId: 'P-001', quantity: '2' }], customer: validCustomer() },
    { items: [{ productId: 'P-001', quantity: 51 }], customer: validCustomer() },
    { items: [{ productId: 'P-001', quantity: 1 }], customer: validCustomer({ address: '' }) },
    { items: [{ productId: 'P-001', quantity: 1 }], customer: validCustomer({ phone: '12345' }) },
    { items: [{ productId: 'P-001', quantity: 1 }], customer: validCustomer({ phone: '+1 555 000 1111' }) },
    { items: [{ productId: 'P-001', quantity: 1 }], customer: validCustomer({ email: 'amina@@mail' }) },
    { items: [{ productId: 'P-001', quantity: 1 }], customer: validCustomer({ name: '' }) },
  ];
  for (const body of cases) {
    const { status, data } = await call('POST', '/api/orders', { body });
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(Array.isArray(data.details) && data.details.length > 0);
  }
});

test('accepts +234 phone format and stores it in the local format', async () => {
  const { status, data } = await call('POST', '/api/orders', {
    body: { customer: validCustomer({ phone: '+234 801 234 5678' }), items: [{ productId: 'P-002', quantity: 1 }] },
  });
  assert.equal(status, 201);
  const row = await pool.query('SELECT customer_phone FROM orders WHERE id = $1', [data.order.id]);
  assert.equal(row.rows[0].customer_phone, '08012345678');
});

test('sign-up requires email verification before login', async () => {
  const email = uniqueEmail();
  const signup = await call('POST', '/api/auth/signup', {
    body: { name: 'Tunde Adeyemi', email, phone: '08098765432', password: 'longenough1' },
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.data.token, undefined);

  const early = await call('POST', '/api/auth/login', { body: { email, password: 'longenough1' } });
  assert.equal(early.status, 403);

  const dup = await call('POST', '/api/auth/signup', {
    body: { name: 'Tunde Adeyemi', email, phone: '08098765432', password: 'longenough1' },
  });
  assert.equal(dup.status, 409);

  const token = sent.at(-1).text.match(/verify=([a-f0-9]{64})/)[1];
  assert.equal((await call('POST', '/api/auth/verify-email', { body: { token } })).status, 200);
  // A verification link works once.
  assert.equal((await call('POST', '/api/auth/verify-email', { body: { token } })).status, 400);

  const wrong = await call('POST', '/api/auth/login', { body: { email, password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  const good = await call('POST', '/api/auth/login', { body: { email, password: 'longenough1' } });
  assert.equal(good.status, 200);

  assert.equal((await call('GET', '/api/orders')).status, 401);
  const me = await call('GET', '/api/me', { token: good.data.token });
  assert.equal(me.data.user.email, email);
});

test('password reset emails a one-time link and logs out existing sessions', async () => {
  const email = uniqueEmail();
  const oldToken = await registerAndLogin(email, 'original-pass-1');

  const before = sent.length;
  const req = await call('POST', '/api/auth/forgot-password', { body: { email } });
  assert.equal(req.status, 200);
  assert.equal(sent.length, before + 1);
  const resetToken = sent.at(-1).text.match(/reset=([a-f0-9]{64})/)[1];

  // Unknown addresses get the same answer and no email.
  const unknown = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody@example.com' } });
  assert.equal(unknown.status, 200);
  assert.equal(sent.length, before + 1);

  const weak = await call('POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'short' } });
  assert.equal(weak.status, 400);

  const done = await call('POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'brand-new-pass-2' } });
  assert.equal(done.status, 200);
  assert.equal((await call('POST', '/api/auth/reset-password', { body: { token: resetToken, password: 'another-pass-3' } })).status, 400);

  assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'original-pass-1' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'brand-new-pass-2' } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: oldToken })).status, 401);
});

// ---------- Level 3: cancellation and stock ----------

test('customer cancels a Pending order and stock is restored; second cancel is refused', async () => {
  const before = await stockOf('P-003');
  const created = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-003', quantity: 3 }] },
  });
  const id = created.data.order.id;
  assert.equal(await stockOf('P-003'), before - 3);

  const wrongPhone = await call('POST', `/api/orders/${id}/cancel`, { body: { phone: '08000000000' } });
  assert.equal(wrongPhone.status, 403);

  const ok = await call('POST', `/api/orders/${id}/cancel`, { body: { phone: '08012345678' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.order.status, 'Cancelled');
  assert.equal(await stockOf('P-003'), before);

  const again = await call('POST', `/api/orders/${id}/cancel`, { body: { phone: '08012345678' } });
  assert.equal(again.status, 409);
  assert.equal(await stockOf('P-003'), before);
});

test('shipped and delivered orders cannot be cancelled', async () => {
  const created = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-004', quantity: 1 }] },
  });
  const id = created.data.order.id;
  for (const status of ['Processing', 'Shipped']) {
    const r = await call('PATCH', `/api/admin/orders/${id}/status`, { body: { status }, headers: adminHeaders });
    assert.equal(r.status, 200);
  }
  const cancel = await call('POST', `/api/orders/${id}/cancel`, { body: { phone: '08012345678' } });
  assert.equal(cancel.status, 409);
  assert.match(cancel.data.error, /Shipped/);
});

test('two buyers racing for the last unit: exactly one succeeds', async () => {
  await pool.query(
    `INSERT INTO products (id, name, category, price, stock, description)
     VALUES ('P-100', 'Last Unit', 'Electronics', 1000, 1, 'race test')`,
  );
  const attempts = Array.from({ length: 20 }, (_, i) =>
    fetch(`${base}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: validCustomer({ name: `Buyer ${i}` }), items: [{ productId: 'P-100', quantity: 1 }] }),
    }).then((r) => r.status),
  );
  const statuses = await Promise.all(attempts);
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 19);
  assert.equal(await stockOf('P-100'), 0);
});

// ---------- Level 4: idempotency and history ----------

test('retried checkout with the same Idempotency-Key creates one order and one stock deduction', async () => {
  const before = await stockOf('P-005');
  const headers = { 'Idempotency-Key': 'checkout-abc-12345' };
  const body = { customer: validCustomer(), items: [{ productId: 'P-005', quantity: 2 }] };

  const first = await call('POST', '/api/orders', { body, headers });
  const second = await call('POST', '/api/orders', { body, headers });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.data.replayed, true);
  assert.equal(second.data.order.id, first.data.order.id);
  assert.equal(await stockOf('P-005'), before - 2);
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE id = $1', [first.data.order.id]);
  assert.equal(count.rows[0].n, 1);
});

test('concurrent retries with the same Idempotency-Key still create one order', async () => {
  const before = await stockOf('P-002');
  const headers = { 'Idempotency-Key': 'double-click-98765' };
  const body = { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => call('POST', '/api/orders', { body, headers })),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(new Set(results.map((r) => r.data.order.id)).size, 1);
  assert.equal(await stockOf('P-002'), before - 1);
});

test('reusing an Idempotency-Key for a different order is rejected', async () => {
  const headers = { 'Idempotency-Key': 'checkout-xyz-98765' };
  await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] },
    headers,
  });
  const clash = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 2 }] },
    headers,
  });
  assert.equal(clash.status, 409);
});

test('malformed Idempotency-Key is a validation error', async () => {
  const { status } = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] },
    headers: { 'Idempotency-Key': 'short' },
  });
  assert.equal(status, 400);
});

test('order history is paginated and filterable by Active / Completed / Cancelled', async () => {
  const token = await registerAndLogin();
  const customer = validCustomer({ phone: '08011112222' });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/orders', {
      body: { customer, items: [{ productId: 'P-007', quantity: 1 }] },
      token,
    });
    ids.push(r.data.order.id);
  }
  await call('POST', `/api/orders/${ids[0]}/cancel`, { body: {}, token });
  for (const status of ['Processing', 'Shipped', 'Delivered']) {
    await call('PATCH', `/api/admin/orders/${ids[1]}/status`, { body: { status }, headers: adminHeaders });
  }

  const all = await call('GET', '/api/orders?pageSize=2', { token });
  assert.equal(all.data.total, 3);
  assert.equal(all.data.items.length, 2);
  assert.equal(all.data.totalPages, 2);
  const page2 = await call('GET', '/api/orders?pageSize=2&page=2', { token });
  assert.equal(page2.data.items.length, 1);

  const active = await call('GET', '/api/orders?status=active', { token });
  assert.deepEqual(active.data.items.map((o) => o.id), [ids[2]]);
  const completed = await call('GET', '/api/orders?status=completed', { token });
  assert.deepEqual(completed.data.items.map((o) => o.id), [ids[1]]);
  const cancelled = await call('GET', '/api/orders?status=cancelled', { token });
  assert.deepEqual(cancelled.data.items.map((o) => o.id), [ids[0]]);

  const bogus = await call('GET', '/api/orders?status=constructor', { token });
  assert.equal(bogus.status, 400);
});

// ---------- Level 5: rate limits, admin, hygiene ----------

test('order creation is rate limited per IP and returns Retry-After', async () => {
  const limited = createApp({
    pool,
    mailer,
    adminToken: ADMIN,
    limits: { ...LIMITS_OFF, orderCreate: { max: 2, windowMs: 60000 } },
  });
  await new Promise((resolve) => limited.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${limited.server.address().port}/api/orders`;
  try {
    const body = JSON.stringify({ customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] });
    const send = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 201);
    const blocked = await send();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    await new Promise((resolve) => limited.server.close(resolve));
  }
});

test('admin endpoints require the admin token', async () => {
  assert.equal((await call('GET', '/api/admin/orders')).status, 401);
  assert.equal((await call('GET', '/api/admin/orders', { token: 'nope' })).status, 403);
  assert.equal((await call('GET', '/api/admin/orders', { token: ADMIN })).status, 200);
});

test('admin transitions follow Pending -> Processing -> Shipped -> Delivered only', async () => {
  const created = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-008', quantity: 1 }] },
  });
  const id = created.data.order.id;
  const move = (status) => call('PATCH', `/api/admin/orders/${id}/status`, { body: { status }, headers: adminHeaders });

  assert.equal((await move('Shipped')).status, 409); // skipping Processing is refused
  assert.equal((await move('Processing')).status, 200);
  assert.equal((await move('Shipped')).status, 200);
  assert.equal((await move('Pending')).status, 409); // no going backwards
  assert.equal((await move('Delivered')).status, 200);
  const history = (await call('GET', `/api/orders/${id}`)).data.order.statusHistory.map((h) => h.status);
  assert.deepEqual(history, ['Pending', 'Processing', 'Shipped', 'Delivered']);
});

test('malformed JSON is rejected cleanly', async () => {
  const { status, data } = await call('POST', '/api/orders', { body: '{"customer":' });
  assert.equal(status, 400);
  assert.equal(data.error, 'Malformed JSON body');
});

test('responses carry security headers', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const api = await fetch(`${base}/api/health`);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

// ---------- Admin product management ----------

test('admin can add a product and edit its price, stock and description', async () => {
  const created = await call('POST', '/api/admin/products', {
    body: { name: 'Steel Staples (Box)', category: 'Packaging', price: 2500, stock: 15, description: 'Box of 1000.' },
    headers: adminHeaders,
  });
  assert.equal(created.status, 201);
  const id = created.data.product.id;
  assert.match(id, /^P-\d{3}$/);

  const edited = await call('PATCH', `/api/admin/products/${id}`, {
    body: { price: 2750, stock: 3 },
    headers: adminHeaders,
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.product.price, 2750);
  assert.equal(edited.data.product.stock, 3);
  assert.equal(edited.data.product.stockStatus, 'low');
  assert.equal(edited.data.product.name, 'Steel Staples (Box)');

  // The storefront sees the change straight away.
  const shop = await call('GET', '/api/products?q=staples');
  assert.equal(shop.data.products[0].price, 2750);
});

test('admin product edits validate input and require the admin token', async () => {
  assert.equal((await call('PATCH', '/api/admin/products/P-001', { body: { price: 1 } })).status, 401);
  const bad = [
    { price: -5 },
    { price: 12.5 },
    { stock: -1 },
    { category: 'Toys' },
    { name: 'x' },
    {},
  ];
  for (const body of bad) {
    const r = await call('PATCH', '/api/admin/products/P-001', { body, headers: adminHeaders });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await call('PATCH', '/api/admin/products/P-999', { body: { price: 1 }, headers: adminHeaders })).status, 404);
});

test('admin stock changes flow through to checkout', async () => {
  await call('PATCH', '/api/admin/products/P-006', { body: { stock: 1 }, headers: adminHeaders });
  const over = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-006', quantity: 2 }] },
  });
  assert.equal(over.status, 409);
  await call('PATCH', '/api/admin/products/P-006', { body: { stock: 5 }, headers: adminHeaders });
  const ok = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-006', quantity: 2 }] },
  });
  assert.equal(ok.status, 201);
});

// ---------- Payments ----------

test('pay on delivery is the default; bank transfer shows the account details', async () => {
  const cod = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] },
  });
  assert.equal(cod.status, 201);
  assert.equal(cod.data.order.paymentMethod, 'cod');
  assert.equal(cod.data.order.paymentStatus, 'pay_on_delivery');
  assert.equal(cod.data.bankDetails, undefined);

  const transfer = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }], paymentMethod: 'transfer' },
  });
  assert.equal(transfer.status, 201);
  assert.equal(transfer.data.order.paymentStatus, 'awaiting_transfer');
  assert.match(transfer.data.bankDetails, /0123456789/);

  const bad = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }], paymentMethod: 'crypto' },
  });
  assert.equal(bad.status, 400);
});

test('bank transfer is refused when no bank details are configured', async () => {
  const noBank = createApp({ pool, mailer, adminToken: ADMIN, limits: LIMITS_OFF });
  await new Promise((resolve) => noBank.server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${noBank.server.address().port}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }], paymentMethod: 'transfer' }),
    });
    assert.equal(r.status, 400);
  } finally {
    await new Promise((resolve) => noBank.server.close(resolve));
  }
});

test('admin marks transfers as paid; cash is collected when a cash order is delivered', async () => {
  const transfer = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }], paymentMethod: 'transfer' },
  });
  const tid = transfer.data.order.id;
  const paid = await call('POST', `/api/admin/orders/${tid}/mark-paid`, { headers: adminHeaders });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.order.paymentStatus, 'paid');

  const cod = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] },
  });
  const cid = cod.data.order.id;
  for (const status of ['Processing', 'Shipped', 'Delivered']) {
    await call('PATCH', `/api/admin/orders/${cid}/status`, { body: { status }, headers: adminHeaders });
  }
  const delivered = await call('GET', `/api/orders/${cid}`);
  assert.equal(delivered.data.order.paymentStatus, 'paid');

  const cancelled = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-002', quantity: 1 }] },
  });
  await call('POST', `/api/orders/${cancelled.data.order.id}/cancel`, { body: { phone: '08012345678' } });
  const bad = await call('POST', `/api/admin/orders/${cancelled.data.order.id}/mark-paid`, { headers: adminHeaders });
  assert.equal(bad.status, 409);
});

// ---------- Product delete and archive ----------

test('deleting a product that was never ordered removes it', async () => {
  const created = await call('POST', '/api/admin/products', {
    body: { name: 'Temporary Item', category: 'Essentials', price: 100, stock: 4, description: '' },
    headers: adminHeaders,
  });
  const id = created.data.product.id;
  const del = await call('DELETE', `/api/admin/products/${id}`, { headers: adminHeaders });
  assert.equal(del.data.action, 'deleted');
  assert.equal((await call('DELETE', `/api/admin/products/${id}`, { headers: adminHeaders })).status, 404);
});

test('deleting a product with order history archives it; it can be restored', async () => {
  const before = await call('GET', '/api/products?category=Packaging');
  assert.ok(before.data.products.some((p) => p.id === 'P-007'));

  const del = await call('DELETE', '/api/admin/products/P-007', { headers: adminHeaders });
  assert.equal(del.data.action, 'archived'); // P-007 appears in earlier orders

  const shop = await call('GET', '/api/products?category=Packaging');
  assert.ok(!shop.data.products.some((p) => p.id === 'P-007'));
  const admin = await call('GET', '/api/admin/products', { headers: adminHeaders });
  assert.equal(admin.data.products.find((p) => p.id === 'P-007').archived, true);

  const blocked = await call('POST', '/api/orders', {
    body: { customer: validCustomer(), items: [{ productId: 'P-007', quantity: 1 }] },
  });
  assert.equal(blocked.status, 400);

  await call('PATCH', '/api/admin/products/P-007', { body: { archived: false }, headers: adminHeaders });
  const back = await call('GET', '/api/products?category=Packaging');
  assert.ok(back.data.products.some((p) => p.id === 'P-007'));
});

test('product delete requires the admin token', async () => {
  assert.equal((await call('DELETE', '/api/admin/products/P-001')).status, 401);
});

// ---------- PWA ----------

test('the site ships a web app manifest, icons and a service worker', async () => {
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /manifest/);
  const m = await manifest.json();
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512'));
  assert.equal((await fetch(`${base}/icons/icon-512.png`)).status, 200);
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(await sw.text(), /\/api\//); // the worker explicitly skips API calls
});