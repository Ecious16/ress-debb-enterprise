'use strict';

const PHONE_RE = /^(\+234|0)\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PRODUCT_ID_RE = /^P-\d{3}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_LINE_QTY = 50;
const PAYMENT_METHODS = ['cod', 'transfer'];
const MAX_LINES = 30;

/** Accepts 0XXXXXXXXXX or +234XXXXXXXXXX (spaces, dashes, brackets ignored). Returns 0XXXXXXXXXX or null. */
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s\-()]/g, '');
  if (!PHONE_RE.test(s)) return null;
  return s.startsWith('+234') ? `0${s.slice(4)}` : s;
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

/** Trimmed string within [min, max] characters, or null. */
function text(raw, min, max) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s.length >= min && s.length <= max ? s : null;
}

const isBlank = (v) => v === undefined || v === null || v === '';

function validateOrder(body) {
  const errors = [];
  const value = { customer: null, items: [] };

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'Request body must be a JSON object' }], value };
  }

  const c = body.customer && typeof body.customer === 'object' ? body.customer : null;
  if (!c) {
    errors.push({ field: 'customer', message: 'Customer and delivery details are required' });
  } else {
    const name = text(c.name, 2, 80);
    if (!name || !/\p{L}/u.test(name)) errors.push({ field: 'customer.name', message: 'Enter your full name (2-80 letters)' });

    const phone = normalizePhone(c.phone);
    if (!phone) errors.push({ field: 'customer.phone', message: 'Enter a valid Nigerian phone number, e.g. 08012345678 or +2348012345678' });

    let email = null;
    if (!isBlank(c.email)) {
      email = normalizeEmail(c.email);
      if (!email) errors.push({ field: 'customer.email', message: 'Enter a valid email address' });
    }

    const address = text(c.address, 5, 200);
    if (!address) errors.push({ field: 'customer.address', message: 'Enter a delivery address (5-200 characters)' });

    let notes = '';
    if (!isBlank(c.notes)) {
      notes = text(c.notes, 0, 500);
      if (notes === null) errors.push({ field: 'customer.notes', message: 'Notes must be at most 500 characters' });
    }

    value.customer = { name, phone, email, address, notes };
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push({ field: 'items', message: 'Your cart is empty' });
  } else if (body.items.length > MAX_LINES) {
    errors.push({ field: 'items', message: `An order can contain at most ${MAX_LINES} different items` });
  } else {
    const merged = new Map();
    body.items.forEach((line, i) => {
      const f = `items[${i}]`;
      if (!line || typeof line !== 'object' || Array.isArray(line)) {
        errors.push({ field: f, message: 'Invalid cart line' });
        return;
      }
      const pid = typeof line.productId === 'string' ? line.productId.trim() : '';
      if (!PRODUCT_ID_RE.test(pid)) errors.push({ field: `${f}.productId`, message: 'Invalid product' });

      const q = line.quantity;
      // Strict: must be a JSON number that is a whole number. "2" and 1.5 are rejected.
      if (!Number.isInteger(q) || q < 1 || q > MAX_LINE_QTY) {
        errors.push({ field: `${f}.quantity`, message: `Quantity must be a whole number from 1 to ${MAX_LINE_QTY}` });
      } else if (PRODUCT_ID_RE.test(pid)) {
        merged.set(pid, (merged.get(pid) || 0) + q);
      }
    });

    value.items = [...merged]
      .map(([productId, quantity]) => ({ productId, quantity }))
      .sort((a, b) => a.productId.localeCompare(b.productId));

    for (const it of value.items) {
      if (it.quantity > MAX_LINE_QTY) {
        errors.push({ field: 'items', message: `Total quantity for ${it.productId} cannot exceed ${MAX_LINE_QTY}` });
      }
    }
  }

  const method = body.paymentMethod ?? 'cod';
  if (!PAYMENT_METHODS.includes(method)) {
    errors.push({ field: 'paymentMethod', message: 'Choose pay on delivery or bank transfer' });
  } else {
    value.paymentMethod = method;
  }

  return { errors, value };
}

function validateSignup(body) {
  const errors = [];
  const value = {};
  const b = body && typeof body === 'object' ? body : {};

  value.name = text(b.name, 2, 80);
  if (!value.name || !/\p{L}/u.test(value.name)) errors.push({ field: 'name', message: 'Enter your full name' });

  value.email = normalizeEmail(b.email);
  if (!value.email) errors.push({ field: 'email', message: 'Enter a valid email address' });

  value.phone = normalizePhone(b.phone);
  if (!value.phone) errors.push({ field: 'phone', message: 'Enter a valid Nigerian phone number' });

  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128) {
    errors.push({ field: 'password', message: 'Password must be 8-128 characters' });
  }
  value.password = b.password;

  return { errors, value };
}

function validateLogin(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const email = normalizeEmail(b.email);
  if (!email) errors.push({ field: 'email', message: 'Enter a valid email address' });
  if (typeof b.password !== 'string' || b.password.length === 0) errors.push({ field: 'password', message: 'Password is required' });
  return { errors, value: { email, password: b.password } };
}

/** Returns { key } when valid or absent, { error } when malformed. */
function validateIdempotencyKey(raw) {
  if (raw === undefined) return { key: null };
  if (typeof raw !== 'string' || !IDEMPOTENCY_RE.test(raw)) {
    return { error: 'Idempotency-Key must be 8-100 characters: letters, digits, "-" or "_"' };
  }
  return { key: raw };
}

const PRODUCT_CATEGORIES = ['Electronics', 'Essentials', 'Packaging'];

/** Validates a product for create (full) or edit (partial). Prices and stock are whole numbers. */
function validateProduct(body, { partial = false } = {}) {
  const errors = [];
  const value = {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const wants = (key) => !partial || b[key] !== undefined;

  if (wants('name')) {
    const name = text(b.name, 2, 80);
    if (!name) errors.push({ field: 'name', message: 'Name must be 2-80 characters' });
    else value.name = name;
  }
  if (wants('description')) {
    const description = text(b.description ?? '', 0, 300);
    if (description === null) errors.push({ field: 'description', message: 'Description must be at most 300 characters' });
    else value.description = description;
  }
  if (wants('category')) {
    if (!PRODUCT_CATEGORIES.includes(b.category)) {
      errors.push({ field: 'category', message: `Category must be one of: ${PRODUCT_CATEGORIES.join(', ')}` });
    } else value.category = b.category;
  }
  if (wants('price')) {
    if (!Number.isInteger(b.price) || b.price < 0 || b.price > 100000000) {
      errors.push({ field: 'price', message: 'Price must be a whole number of naira (0 to 100,000,000)' });
    } else value.price = b.price;
  }
  if (wants('stock')) {
    if (!Number.isInteger(b.stock) || b.stock < 0 || b.stock > 1000000) {
      errors.push({ field: 'stock', message: 'Stock must be a whole number from 0 to 1,000,000' });
    } else value.stock = b.stock;
  }
  if (partial && b.archived !== undefined) {
    if (typeof b.archived !== 'boolean') errors.push({ field: 'archived', message: 'archived must be true or false' });
    else value.archived = b.archived;
  }
  if (partial && Object.keys(value).length === 0) errors.push({ field: 'body', message: 'Nothing to update' });
  return { errors, value };
}

module.exports = {
  validateProduct,
  PAYMENT_METHODS,
  PRODUCT_CATEGORIES,
  MAX_LINE_QTY,
  normalizePhone,
  normalizeEmail,
  validateOrder,
  validateSignup,
  validateLogin,
  validateIdempotencyKey,
};