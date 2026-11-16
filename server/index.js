'use strict';

const { loadConfig } = require('./config');
const { createPool, migrate, seedProducts } = require('./db');
const { createApp } = require('./app');
const { createMailer } = require('./mailer');

async function main() {
  const { config, problems } = loadConfig(process.env);
  if (problems.length) {
    console.error('Refusing to start:\n - ' + problems.join('\n - '));
    process.exit(1);
  }

  const pool = createPool({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  await migrate(pool);
  await seedProducts(pool);

  const generatedAdminToken = !config.adminToken;
  const { server, adminToken } = createApp({
    pool,
    mailer: createMailer({ apiKey: config.mailApiKey, from: config.mailFrom, isProduction: config.isProduction }),
    adminToken: config.adminToken || undefined,
    appUrl: config.appUrl,
    isProduction: config.isProduction,
    trustProxy: config.trustProxy,
    bankDetails: config.bankDetails,
    emailEnabled: config.emailEnabled,
  });

  server.listen(config.port, () => {
    console.log(`Ress - Debb running on port ${config.port}${config.isProduction ? ' (production)' : ''}`);
    if (!config.isProduction) console.log(`Site: ${config.appUrl}   Admin: ${config.appUrl}/admin`);
    if (generatedAdminToken && !config.isProduction) {
      console.log(`Admin token (generated for this run; set ADMIN_TOKEN to keep it fixed): ${adminToken}`);
    }
  });

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});