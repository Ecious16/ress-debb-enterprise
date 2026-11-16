'use strict';

/**
 * Sends transactional email through Resend's HTTP API.
 * Without MAIL_API_KEY (development only) messages are written to the console.
 * Config validation refuses to start in production without a key.
 */
function createMailer({ apiKey = '', from = '', isProduction = false } = {}) {
  return {
    async send({ to, subject, text }) {
      if (!apiKey) {
        if (isProduction) throw new Error('Mail is not configured');
        console.log(`[dev mail to ${to}] ${subject}\n${text}\n`);
        return;
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!res.ok) throw new Error(`Mail provider responded ${res.status}`);
    },
  };
}

module.exports = { createMailer };