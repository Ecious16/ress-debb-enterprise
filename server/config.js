'use strict';

/**
 * Reads and checks environment configuration. Returns { config, problems }.
 * In production every required value must be present and strong enough.
 */
function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const problems = [];

  const databaseUrl = env.DATABASE_URL || '';
  if (!databaseUrl) problems.push('DATABASE_URL is required (Neon connection string)');

  const adminToken = env.ADMIN_TOKEN || '';
  if (isProduction && adminToken.length < 32) {
    problems.push('ADMIN_TOKEN must be set to at least 32 characters in production');
  }

  const appUrl = (env.APP_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/+$/, '');
  if (isProduction && !/^https:\/\//.test(appUrl)) {
    problems.push('APP_URL must be the public https:// address of the site in production');
  }

  const mailApiKey = env.MAIL_API_KEY || '';
  const mailFrom = env.MAIL_FROM || '';
  if (isProduction && !mailApiKey) problems.push('MAIL_API_KEY is required in production (verification and reset emails)');
  if (mailApiKey && !mailFrom) problems.push('MAIL_FROM is required when MAIL_API_KEY is set');

  return {
    problems,
    config: {
      isProduction,
      port: Number(env.PORT) || 3000,
      databaseUrl,
      databaseSsl: env.DATABASE_SSL === 'true',
      adminToken,
      appUrl,
      trustProxy: env.TRUST_PROXY === '1',
      mailApiKey,
      mailFrom,
      bankDetails: env.BANK_TRANSFER_DETAILS || '',
    },
  };
}

module.exports = { loadConfig };