'use strict';

const crypto = require('crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  const candidate = crypto.scryptSync(password, user.salt, KEY_LENGTH);
  const stored = Buffer.from(user.hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

module.exports = { hashPassword, verifyPassword };