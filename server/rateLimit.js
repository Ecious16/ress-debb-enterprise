'use strict';

/** In-memory sliding-window limiter. Fine for one process; use Redis if you scale out. */
class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  hit(key, max, windowMs) {
    const now = Date.now();
    if (this.hits.size > 10000) this.sweep(now);

    const recent = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfter: Math.ceil((recent[0] + windowMs - now) / 1000) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfter: 0 };
  }

  sweep(now) {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= 60 * 60 * 1000)) this.hits.delete(key);
    }
  }
}

module.exports = { RateLimiter };