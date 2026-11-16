'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withTx, migrate, seedProducts } = require('./db');
const { hashPassword, verifyPassword } = require('./passwords');
const {
  normalizePhone,
  normalizeEmail,
  validateOrder,
  validateSignup,
  validateLogin,
  validateIdempotencyKey,
  validateProduct,
  PAYMENT_METHODS,
} = require('./validation');
const { RateLimiter } = require('./rateLimit');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_TTL_DAYS = 7;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const ORDER_ID_RE = /^RDE-\d{6}$/;

const ORDER_STATUSES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
// Customers may cancel only while the order has not left the warehouse.
const CANCELLABLE = ['Pending', 'Processing'];
// Admin moves: Pending -> Processing -> Shipped -> Delivered, and open orders may be Cancelled.
const NEXT_STATUS = {
  Pending: ['Processing', 'Cancelled'],
  Processing: ['Shipped', 'Cancelled'],
  Shipped: ['Delivered'],
  Delivered: [],
  Cancelled: [],
};
const STATUS_FILTERS = {
  active: ['Pending', 'Processing', 'Shipped'],
  completed: ['Delivered'],
  cancelled: ['Cancelled'],
};
const MIME = {
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // inline onclick handlers; see README
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message, details, headers) {
    super(message);
    this.status = status;
    this.details = details;
    this.headers = headers || {};
  }
}

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const iso = (d) => new Date(d).toISOString();
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'Request body is too large'));
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {});
      } catch {
        reject(new HttpError(400, 'Malformed JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function bearer(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}

function applySecurityHeaders(res, isProduction) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// ---------- Mapping ----------

function publicOrderView(o) {
  return {
    id: o.id,
    status: o.status,
    items: o.items,
    total: o.total,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    statusHistory: o.statusHistory,
    customerFirstName: o.customer.name.split(' ')[0],
    cancellable: CANCELLABLE.includes(o.status),
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    paymentLabel: PAYMENT_LABELS[o.paymentStatus],
  };
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone });

function publicProduct(p) {
  const stockStatus = p.stock === 0 ? 'out' : p.stock <= 5 ? 'low' : 'in';
  return {
    id: p.id, name: p.name, category: p.category, price: p.price, stock: p.stock,
    description: p.description, stockStatus, archived: Boolean(p.archived),
  };
}

const PAYMENT_LABELS = { pay_on_delivery: 'Pay on delivery', awaiting_transfer: 'Awaiting bank transfer', paid: 'Paid' };

function mapOrder(row, items, history) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customer: {
      name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
      address: row.customer_address,
      notes: row.customer_notes,
    },
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.name,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      lineTotal: i.line_total,
    })),
    total: row.total,
    status: row.status,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    statusHistory: history.map((h) => ({ status: h.status, at: iso(h.at) })),
  };
}

/** Loads full orders and returns them in the same order as `ids`. */
async function loadOrdersByIds(db, ids) {
  if (!ids.length) return [];
  const orders = await db.query('SELECT * FROM orders WHERE id = ANY($1)', [ids]);
  const items = await db.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY product_id', [ids]);
  const history = await db.query('SELECT * FROM order_status_history WHERE order_id = ANY($1) ORDER BY id', [ids]);
  const byId = new Map(
    orders.rows.map((row) => [
      row.id,
      mapOrder(
        row,
        items.rows.filter((i) => i.order_id === row.id),
        history.rows.filter((h) => h.order_id === row.id),
      ),
    ]),
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function loadOrderById(db, id) {
  return (await loadOrdersByIds(db, [id]))[0] || null;
}

/** Appends a status filter to the SQL condition list. Throws 400 for unknown filters. */
function addStatusFilter(conditions, params, status) {
  if (!status || status === 'all') return;
  if (hasOwn(STATUS_FILTERS, status)) {
    params.push(STATUS_FILTERS[status]);
    conditions.push(`status = ANY($${params.length})`);
    return;
  }
  if (ORDER_STATUSES.includes(status)) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
    return;
  }
  throw new HttpError(400, 'Invalid status filter');
}

async function pagedOrders(db, conditions, params, searchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '10', 10) || 10));
  const where = conditions.length ? conditions.join(' AND ') : 'TRUE';

  const count = await db.query(`SELECT COUNT(*)::int AS n FROM orders WHERE ${where}`, params);
  const total = count.rows[0].n;
  const ids = (
    await db.query(
      `SELECT id FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    )
  ).rows.map((r) => r.id);

  return {
    items: await loadOrdersByIds(db, ids),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---------- Sessions, tokens, accounts ----------

async function createSession(db, userId) {
  const token = randomToken();
  await db.query('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [sha256hex(token), userId]);
  return token;
}

async function currentUser(db, req) {
  const token = bearer(req);
  if (!token) return null;
  const r = await db.query(
    `SELECT u.id, u.name, u.email, u.phone
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.created_at > now() - interval '${SESSION_TTL_DAYS} days'`,
    [sha256hex(token)],
  );
  return r.rows[0] ? publicUser(r.rows[0]) : null;
}

async function requireUser(db, req) {
  const user = await currentUser(db, req);
  if (!user) throw new HttpError(401, 'Please log in to continue');
  return user;
}

async function issueAuthToken(db, userId, purpose, ttlMs) {
  const token = randomToken();
  await db.query(
    'INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [sha256hex(token), userId, purpose, new Date(Date.now() + ttlMs)],
  );
  return token;
}

/** Marks a one-time token as used and returns its user id. Must run inside a transaction. */
async function consumeAuthToken(client, token, purpose) {
  const r = await client.query(
    `SELECT user_id FROM auth_tokens
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [sha256hex(token), purpose],
  );
  if (!r.rowCount) throw new HttpError(400, 'This link is invalid or has expired. Please request a new one.');
  await client.query('UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1', [sha256hex(token)]);
  return r.rows[0].user_id;
}

/** Email failures are logged, not returned, so an outage never reveals which accounts exist. */
async function deliver(mailer, to, subject, text) {
  try {
    await mailer.send({ to, subject, text });
  } catch (err) {
    console.error('Mail delivery failed:', err.message);
  }
}

// ---------- Order helpers ----------

async function newOrderId(client) {
  for (let i = 0; i < 20; i++) {
    const id = `RDE-${crypto.randomInt(100000, 1000000)}`;
    const taken = await client.query('SELECT 1 FROM orders WHERE id = $1', [id]);
    if (!taken.rowCount) return id;
  }
  throw new HttpError(503, 'Could not allocate an Order ID right now. Please try again.');
}

/** Sets the status and, when cancelling, returns the reserved stock. Must run inside a transaction. */
async function changeStatus(client, orderId, next) {
  if (next === 'Cancelled') {
    const items = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [orderId]);
    for (const it of items.rows) {
      await client.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [it.product_id, it.quantity]);
    }
  }
  // Cash on delivery is collected when the parcel is delivered.
  await client.query(
    `UPDATE orders SET status = $2, updated_at = now(),
            payment_status = CASE WHEN $2 = 'Delivered' AND payment_method = 'cod' THEN 'paid' ELSE payment_status END
      WHERE id = $1`,
    [orderId, next],
  );
  await client.query('INSERT INTO order_status_history (order_id, status, at) VALUES ($1, $2, now())', [orderId, next]);
}

// ---------- App ----------

function createApp(options = {}) {
  const { pool } = options;
  if (!pool) throw new Error('createApp requires a database pool');
  const isProduction = Boolean(options.isProduction);
  const appUrl = options.appUrl || 'http://localhost:3000';
  const mailer = options.mailer;
  const limiter = new RateLimiter();
  const limits = {
    orderCreate: { max: 5, windowMs: 10 * 60 * 1000 },
    orderCancel: { max: 10, windowMs: 10 * 60 * 1000 },
    orderLookup: { max: 60, windowMs: 60 * 1000 },
    auth: { max: 10, windowMs: 15 * 60 * 1000 },
    ...options.limits,
  };
  const trustProxy = Boolean(options.trustProxy);
  const adminToken = options.adminToken || crypto.randomBytes(24).toString('hex');
  const bankDetails = options.bankDetails || '';
  const adminTokenHash = crypto.createHash('sha256').update(adminToken).digest();

  function enforce(bucket, ip, limit) {
    const r = limiter.hit(`${bucket}:${ip}`, limit.max, limit.windowMs);
    if (!r.allowed) {
      throw new HttpError(429, 'Too many requests. Please wait before trying again.', null, {
        'Retry-After': String(r.retryAfter),
      });
    }
  }

  function requireAdmin(req) {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'Admin token required');
    if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(), adminTokenHash)) {
      throw new HttpError(403, 'Invalid admin token');
    }
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const ip = clientIp(req, trustProxy);

    if (method === 'GET' && p === '/api/health') {
      await pool.query('SELECT 1');
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/products') {
      const q = (url.searchParams.get('q') || '').trim();
      const category = url.searchParams.get('category') || 'All';
      const conditions = ['archived = false', 'stock > 0'];
      const params = [];
      if (category !== 'All') {
        params.push(category);
        conditions.push(`category = $${params.length}`);
      }
      if (q) {
        params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
        conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }
      const rows = await pool.query(
        `SELECT * FROM products WHERE ${conditions.join(' AND ') || 'TRUE'} ORDER BY id`,
        params,
      );
      return send(res, 200, { products: rows.rows.map(publicProduct) });
    }

    // ---- Accounts ----
    if (method === 'POST' && p === '/api/auth/signup') {
      enforce('auth', ip, limits.auth);
      const { errors, value } = validateSignup(await readJson(req));
      if (errors.length) throw new HttpError(400, 'Please correct the highlighted fields', errors);
      const { salt, hash } = hashPassword(value.password);
      const userId = `U-${crypto.randomUUID()}`;
      let verifyToken;
      try {
        verifyToken = await withTx(pool, async (c) => {
          await c.query(
            'INSERT INTO users (id, name, email, phone, salt, hash) VALUES ($1, $2, $3, $4, $5, $6)',
            [userId, value.name, value.email, value.phone, salt, hash],
          );
          return issueAuthToken(c, userId, 'verify_email', VERIFY_TTL_MS);
        });
      } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
        throw err;
      }
      await deliver(
        mailer,
        value.email,
        'Verify your Ress - Debb account',
        `Hello ${value.name},\n\nConfirm your email to activate your account:\n${appUrl}/?verify=${verifyToken}\n\nThis link expires in 24 hours.`,
      );
      return send(res, 201, { message: 'Account created. Check your email for a verification link before logging in.' });
    }

    if (method === 'POST' && p === '/api/auth/login') {
      enforce('auth', ip, limits.auth);
      const { errors, value } = validateLogin(await readJson(req));
      if (errors.length) throw new HttpError(400, 'Please correct the highlighted fields', errors);
      const row = (await pool.query('SELECT * FROM users WHERE email = $1', [value.email])).rows[0];
      if (!row) {
        hashPassword(value.password); // equalise timing with the real path
        throw new HttpError(401, 'Invalid email or password');
      }
      if (!verifyPassword(value.password, row)) throw new HttpError(401, 'Invalid email or password');
      if (!row.email_verified_at) {
        throw new HttpError(403, 'Please verify your email before logging in. Check your inbox or request a new link.');
      }
      const token = await createSession(pool, row.id);
      return send(res, 200, { token, user: publicUser(row) });
    }

    if (method === 'POST' && p === '/api/auth/logout') {
      const token = bearer(req);
      if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(token)]);
      return send(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/me') {
      return send(res, 200, { user: await requireUser(pool, req) });
    }

    if (method === 'POST' && p === '/api/auth/verify-email') {
      const body = await readJson(req);
      const token = typeof body.token === 'string' ? body.token : '';
      if (!TOKEN_RE.test(token)) throw new HttpError(400, 'This link is invalid or has expired. Please request a new one.');
      await withTx(pool, async (c) => {
        const userId = await consumeAuthToken(c, token, 'verify_email');
        await c.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
      });
      return send(res, 200, { message: 'Email verified. You can now log in.' });
    }

    if (method === 'POST' && p === '/api/auth/resend-verification') {
      enforce('auth', ip, limits.auth);
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (email) {
        const user = (await pool.query(
          'SELECT id, name FROM users WHERE email = $1 AND email_verified_at IS NULL',
          [email],
        )).rows[0];
        if (user) {
          const token = await issueAuthToken(pool, user.id, 'verify_email', VERIFY_TTL_MS);
          await deliver(mailer, email, 'Verify your Ress - Debb account',
            `Hello ${user.name},\n\nConfirm your email:\n${appUrl}/?verify=${token}\n\nThis link expires in 24 hours.`);
        }
      }
      // Same answer whether or not the account exists.
      return send(res, 200, { message: 'If that account needs verification, a new link is on its way.' });
    }

    if (method === 'POST' && p === '/api/auth/forgot-password') {
      enforce('auth', ip, limits.auth);
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (email) {
        const user = (await pool.query('SELECT id, name FROM users WHERE email = $1', [email])).rows[0];
        if (user) {
          const token = await issueAuthToken(pool, user.id, 'reset_password', RESET_TTL_MS);
          await deliver(mailer, email, 'Reset your Ress - Debb password',
            `Hello ${user.name},\n\nReset your password here:\n${appUrl}/?reset=${token}\n\nThis link expires in 1 hour. If you did not ask for this, ignore this email.`);
        }
      }
      return send(res, 200, { message: 'If an account exists for that email, a reset link is on its way.' });
    }

    if (method === 'POST' && p === '/api/auth/reset-password') {
      const body = await readJson(req);
      const token = typeof body.token === 'string' ? body.token : '';
      const password = body.password;
      if (!TOKEN_RE.test(token)) throw new HttpError(400, 'This link is invalid or has expired. Please request a new one.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw new HttpError(400, 'Please correct the highlighted fields', [
          { field: 'password', message: 'Password must be 8-128 characters' },
        ]);
      }
      await withTx(pool, async (c) => {
        const userId = await consumeAuthToken(c, token, 'reset_password');
        const { salt, hash } = hashPassword(password);
        // Resetting proves control of the mailbox, so it also verifies the email.
        await c.query(
          'UPDATE users SET salt = $2, hash = $3, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
          [userId, salt, hash],
        );
        await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]); // log out everywhere
      });
      return send(res, 200, { message: 'Password updated. Please log in with your new password.' });
    }

    // ---- Orders: placement (idempotent, transactional stock reservation) ----
    if (method === 'POST' && p === '/api/orders') {
      enforce('order-create', ip, limits.orderCreate);
      const body = await readJson(req);
      const user = await currentUser(pool, req);
      const { errors, value } = validateOrder(body);
      const idem = validateIdempotencyKey(req.headers['idempotency-key']);
      if (idem.error) errors.push({ field: 'Idempotency-Key', message: idem.error });
      if (errors.length) throw new HttpError(400, 'Please correct the highlighted fields', errors);

      if (value.paymentMethod === 'transfer' && !bankDetails) {
        throw new HttpError(400, 'Bank transfer is not available right now. Please choose pay on delivery.');
      }
      const paymentMethod = value.paymentMethod || 'cod';
      const paymentStatus = paymentMethod === 'transfer' ? 'awaiting_transfer' : 'pay_on_delivery';
      const fingerprint = sha256hex(JSON.stringify({ customer: value.customer, items: value.items, paymentMethod }));
      const scope = user ? `user:${user.id}` : 'guest';

      const result = await withTx(pool, async (c) => {
        if (idem.key) {
          // Serialise identical retries so the second one sees the first one's result.
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${scope}:${idem.key}`]);
          const prev = await c.query(
            'SELECT fingerprint, order_id FROM idempotency_keys WHERE scope = $1 AND key = $2',
            [scope, idem.key],
          );
          if (prev.rowCount) {
            if (prev.rows[0].fingerprint !== fingerprint) {
              throw new HttpError(409, 'This Idempotency-Key was already used for a different order');
            }
            return { replayed: true, orderId: prev.rows[0].order_id };
          }
        }

        // Lock the product rows (sorted, so concurrent orders cannot deadlock), then check stock.
        const found = await c.query(
          'SELECT id, name, price, stock, archived FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE',
          [value.items.map((i) => i.productId)],
        );
        const byId = new Map(found.rows.map((r) => [r.id, r]));
        const unknown = [];
        const shortages = [];
        for (const line of value.items) {
          const product = byId.get(line.productId);
          if (!product || product.archived) unknown.push({ field: line.productId, message: 'Product not found' });
          else if (product.stock < line.quantity) {
            shortages.push({ field: line.productId, message: `Only ${product.stock} of "${product.name}" left in stock` });
          }
        }
        if (unknown.length) throw new HttpError(400, 'Some products are not available', unknown);
        if (shortages.length) throw new HttpError(409, 'Some items do not have enough stock', shortages);

        const lines = value.items.map((line) => {
          const product = byId.get(line.productId);
          return {
            productId: product.id,
            name: product.name,
            unitPrice: product.price,
            quantity: line.quantity,
            lineTotal: product.price * line.quantity,
          };
        });
        const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);

        for (const l of lines) {
          await c.query('UPDATE products SET stock = stock - $2 WHERE id = $1', [l.productId, l.quantity]);
        }

        const orderId = await newOrderId(c);
        const cust = value.customer;
        await c.query(
          `INSERT INTO orders (id, customer_id, customer_name, customer_phone, customer_email,
                               customer_address, customer_notes, status, total, created_at, updated_at,
                               payment_method, payment_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8, now(), now(), $9, $10)`,
          [orderId, user ? user.id : null, cust.name, cust.phone, cust.email, cust.address, cust.notes, total, paymentMethod, paymentStatus],
        );
        for (const l of lines) {
          await c.query(
            'INSERT INTO order_items (order_id, product_id, name, unit_price, quantity, line_total) VALUES ($1, $2, $3, $4, $5, $6)',
            [orderId, l.productId, l.name, l.unitPrice, l.quantity, l.lineTotal],
          );
        }
        await c.query("INSERT INTO order_status_history (order_id, status, at) VALUES ($1, 'Pending', now())", [orderId]);
        if (idem.key) {
          await c.query(
            'INSERT INTO idempotency_keys (scope, key, fingerprint, order_id) VALUES ($1, $2, $3, $4)',
            [scope, idem.key, fingerprint, orderId],
          );
        }
        return { replayed: false, orderId };
      });

      const order = await loadOrderById(pool, result.orderId);
      return send(res, result.replayed ? 200 : 201, {
        replayed: result.replayed,
        order: publicOrderView(order),
        bankDetails: order.paymentMethod === 'transfer' ? bankDetails : undefined,
      });
    }

    // ---- Lookup by Order ID ----
    const lookup = /^\/api\/orders\/(RDE-\d{6})$/i.exec(p);
    if (method === 'GET' && lookup) {
      enforce('order-lookup', ip, limits.orderLookup);
      const order = await loadOrderById(pool, lookup[1].toUpperCase());
      if (!order) throw new HttpError(404, 'No order found with that Order ID');
      return send(res, 200, { order: publicOrderView(order) });
    }

    // ---- Cancellation ----
    const cancel = /^\/api\/orders\/(RDE-\d{6})\/cancel$/i.exec(p);
    if (method === 'POST' && cancel) {
      enforce('order-cancel', ip, limits.orderCancel);
      const id = cancel[1].toUpperCase();
      const body = await readJson(req);
      const user = await currentUser(pool, req);
      const phone = normalizePhone(body.phone);
      await withTx(pool, async (c) => {
        const row = (await c.query(
          'SELECT customer_id, customer_phone, status FROM orders WHERE id = $1 FOR UPDATE',
          [id],
        )).rows[0];
        if (!row) throw new HttpError(404, 'No order found with that Order ID');
        const isOwner = Boolean(user && row.customer_id && row.customer_id === user.id);
        // Guest orders are authorised by the phone number used at checkout.
        const phoneMatches = !row.customer_id && phone !== null && phone === row.customer_phone;
        if (!isOwner && !phoneMatches) {
          throw new HttpError(
            403,
            'Only the customer who placed this order can cancel it. For guest orders, provide the phone number used at checkout.',
          );
        }
        if (!CANCELLABLE.includes(row.status)) {
          throw new HttpError(409, `This order is ${row.status} and can no longer be cancelled`);
        }
        await changeStatus(c, id, 'Cancelled');
      });
      return send(res, 200, { order: publicOrderView(await loadOrderById(pool, id)) });
    }

    // ---- Customer order history ----
    if (method === 'GET' && p === '/api/orders') {
      const user = await requireUser(pool, req);
      const conditions = ['customer_id = $1'];
      const params = [user.id];
      addStatusFilter(conditions, params, url.searchParams.get('status'));
      const page = await pagedOrders(pool, conditions, params, url.searchParams);
      return send(res, 200, { ...page, items: page.items.map(publicOrderView) });
    }

    // ---- Admin ----
    if (p.startsWith('/api/admin/')) {
      requireAdmin(req);

      if (method === 'GET' && p === '/api/admin/orders') {
        const conditions = [];
        const params = [];
        addStatusFilter(conditions, params, url.searchParams.get('status'));
        return send(res, 200, await pagedOrders(pool, conditions, params, url.searchParams));
      }

      if (method === 'GET' && p === '/api/admin/products') {
        const rows = await pool.query('SELECT * FROM products ORDER BY id');
        return send(res, 200, { products: rows.rows.map(publicProduct) });
      }

      if (method === 'POST' && p === '/api/admin/products') {
        const { errors, value } = validateProduct(await readJson(req));
        if (errors.length) throw new HttpError(400, 'Please correct the highlighted fields', errors);
        try {
          const row = await withTx(pool, async (c) => {
            const next = (await c.query(
              "SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 3) AS INTEGER)), 0) + 1 AS n FROM products WHERE id ~ '^P-[0-9]+$'",
            )).rows[0].n;
            const id = `P-${String(next).padStart(3, '0')}`;
            const inserted = await c.query(
              'INSERT INTO products (id, name, category, price, stock, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
              [id, value.name, value.category, value.price, value.stock, value.description],
            );
            return inserted.rows[0];
          });
          return send(res, 201, { product: publicProduct(row) });
        } catch (err) {
          if (err.code === '23505') throw new HttpError(409, 'A product with that ID already exists. Try again.');
          throw err;
        }
      }

      const productEdit = /^\/api\/admin\/products\/(P-\d{3})$/i.exec(p);
      if (method === 'PATCH' && productEdit) {
        const { errors, value } = validateProduct(await readJson(req), { partial: true });
        if (errors.length) throw new HttpError(400, 'Please correct the highlighted fields', errors);
        // Column names come from the validator's fixed whitelist, never from the request.
        const keys = Object.keys(value);
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const row = (await pool.query(
          `UPDATE products SET ${sets} WHERE id = $1 RETURNING *`,
          [productEdit[1].toUpperCase(), ...keys.map((k) => value[k])],
        )).rows[0];
        if (!row) throw new HttpError(404, 'No product found with that ID');
        return send(res, 200, { product: publicProduct(row) });
      }

      const delProduct = /^\/api\/admin\/products\/(P-\d{3})$/i.exec(p);
      if (method === 'DELETE' && delProduct) {
        const id = delProduct[1].toUpperCase();
        // Products that appear in past orders are archived, not deleted, so order history stays intact.
        const action = await withTx(pool, async (c) => {
          const exists = await c.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [id]);
          if (!exists.rowCount) throw new HttpError(404, 'No product found with that ID');
          const used = await c.query('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [id]);
          if (used.rowCount) {
            await c.query('UPDATE products SET archived = true WHERE id = $1', [id]);
            return 'archived';
          }
          await c.query('DELETE FROM products WHERE id = $1', [id]);
          return 'deleted';
        });
        return send(res, 200, { action, id });
      }

      const markPaid = /^\/api\/admin\/orders\/(RDE-\d{6})\/mark-paid$/i.exec(p);
      if (method === 'POST' && markPaid) {
        const id = markPaid[1].toUpperCase();
        await withTx(pool, async (c) => {
          const row = (await c.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
          if (!row) throw new HttpError(404, 'No order found with that Order ID');
          if (row.status === 'Cancelled') throw new HttpError(409, 'A cancelled order cannot be marked as paid');
          await c.query("UPDATE orders SET payment_status = 'paid', updated_at = now() WHERE id = $1", [id]);
        });
        return send(res, 200, { order: await loadOrderById(pool, id) });
      }

      const move = /^\/api\/admin\/orders\/(RDE-\d{6})\/status$/i.exec(p);
      if (method === 'PATCH' && move) {
        const id = move[1].toUpperCase();
        const body = await readJson(req);
        const next = body.status;
        if (!ORDER_STATUSES.includes(next)) {
          throw new HttpError(400, `status must be one of: ${ORDER_STATUSES.join(', ')}`);
        }
        await withTx(pool, async (c) => {
          const row = (await c.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
          if (!row) throw new HttpError(404, 'No order found with that Order ID');
          if (!NEXT_STATUS[row.status].includes(next)) {
            throw new HttpError(409, `Cannot move an order from ${row.status} to ${next}`);
          }
          await changeStatus(c, id, next);
        });
        return send(res, 200, { order: await loadOrderById(pool, id) });
      }
    }

    throw new HttpError(404, 'Endpoint not found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { error: 'Bad request path' });
    }
    if (rel === '/') rel = '/index.html';
    if (rel === '/admin') rel = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    applySecurityHeaders(res, isProduction);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: err.message, details: err.details || undefined }, err.headers);
      }
      console.error(err);
      return send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });

  return { server, adminToken };
}

module.exports = { createApp, migrate, seedProducts };