// End-to-end browser check: storefront, accounts, verification, reset, checkout, cancel, admin.
// Usage: E2E_DATABASE_URL=postgres://.../ress_e2e CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node test/e2e.mjs
// Uses a dev database only: it runs the server against it.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.E2E_DATABASE_URL;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!DB) throw new Error('Set E2E_DATABASE_URL to a dev database');

const PORT = 3402;
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'e2e-admin-token-0123456789-abcdefghijklmnop';
const email = `e2e${Date.now()}@example.com`;
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` (${extra})` : ''}`);
};

const log = [];
const server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: DB,
    ADMIN_TOKEN: ADMIN,
    APP_URL: BASE,
    BANK_TRANSFER_DETAILS: 'Bank: Test Bank\nAccount: 0123456789\nName: Ress - Debb',
  },
});
server.stdout.on('data', (d) => log.push(String(d)));
server.stderr.on('data', (d) => log.push(String(d)));

async function waitForToken(pattern, after = 0) {
  for (let i = 0; i < 50; i++) {
    const text = log.join('');
    const matches = [...text.matchAll(pattern)];
    if (matches.length > after) return matches[matches.length - 1][1];
    await sleep(200);
  }
  throw new Error(`No mail token matching ${pattern} in server log`);
}

let browser;
let page;
try {

  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    await sleep(200);
  }

  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // Failed network requests are logged by the browser; the 403 from the first cancel attempt is expected (see below).
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) pageErrors.push(m.text()); });

  // Dialog answers: confirm() accepts; prompt() answers depend on what is asked.
  page.on('dialog', async (d) => {
    const msg = d.message();
    if (d.type() === 'prompt') {
      if (/phone/i.test(msg)) return d.accept('07089516232'); // the phone used at checkout
      if (/password/i.test(msg)) return d.accept('new-pass-123');
      return d.dismiss();
    }
    return d.accept();
  });

  // ---- Storefront and checkout (guest) ----
  await page.goto(BASE);
  await page.waitForSelector('#productGrid button');
  check('catalogue renders in-stock products with stock badges', (await page.locator('#productGrid > div').count()) >= 8);

  await page.locator('#productGrid > div', { hasText: 'Wireless Mouse' }).getByRole('button', { name: 'Add to cart' }).click();
  await page.locator('#productGrid > div', { hasText: 'Wireless Mouse' }).getByRole('button', { name: 'Add more' }).waitFor();
  check('out-of-stock product is hidden from the shop', (await page.locator('#productGrid > div', { hasText: 'Packing Tape' }).count()) === 0);

  // PWA: manifest linked and the service worker active
  const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
  check('site links a web app manifest', manifestHref === '/manifest.webmanifest');
  const swState = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
  check('service worker is installed and active', swState === 'activated', swState);

  await page.locator('header button', { hasText: 'Cart' }).click();
  await page.fill('#custName', 'Guest Buyer');
  await page.fill('#custPhone', '07089516232');
  await page.fill('#custAddress', '5 Test Avenue, Lagos');
  await page.check('input[name="payMethod"][value="transfer"]');
  await page.click('#placeOrderBtn');
  await page.waitForSelector('#receiptModal:not(.hidden)');
  const orderId = (await page.textContent('#receiptId')).trim();
  check('guest checkout returns a six-digit Order ID', /^RDE-\d{6}$/.test(orderId), orderId);
  await page.waitForFunction(() => document.getElementById('receiptBank').textContent.includes('0123456789'));
  check('bank transfer checkout shows the account details', true);
  await page.click('#receiptModal button:has-text("Done")');

  // ---- Sign-up and email verification ----
  await page.click('#authBtn');
  await page.click('#tabSignup');
  await page.fill('#authName', 'E2E Customer');
  await page.fill('#authPhone', '08098765432');
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', 'longenough1');
  await page.click('#authForm button:has-text("Continue")');
  await page.waitForSelector('text=Check your email');
  check('sign-up asks for email verification', true);

  const verifyToken = await waitForToken(/verify=([a-f0-9]{64})/g);
  await page.goto(`${BASE}/?verify=${verifyToken}`);
  await page.waitForSelector('text=Email verified');
  check('verification link confirms the account', true);

  // ---- Login ----
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', 'longenough1');
  await page.click('#authForm button:has-text("Continue")');
  await page.waitForFunction(() => document.getElementById('authLabel').textContent.includes('E2E'));
  check('login shows the account in the header', true);

  // ---- Order lookup and cancellation (guest order, cancelled by logged-in user with phone) ----
  await page.fill('#orderSearchInput', orderId);
  await page.click('button:has-text("Look up")');
  await page.waitForSelector(`text=${orderId}`);
  await page.click('#lookupResult button:has-text("Cancel Order")');
  await page.waitForSelector('#lookupResult >> text=Cancelled');
  check('guest order can be cancelled with its checkout phone', true);

  // ---- Forgot password and reset ----
  await page.click('#authBtn'); // logs out
  await page.waitForFunction(() => document.getElementById('authLabel').textContent.trim() === 'Log in');
  await page.click('#authBtn');
  await page.fill('#authEmail', email);
  await page.click('#authForm button:has-text("Forgot password")');
  await page.waitForSelector('text=reset link is on its way');
  const resetToken = await waitForToken(/reset=([a-f0-9]{64})/g);
  await page.goto(`${BASE}/?reset=${resetToken}`);
  await page.waitForSelector('#authModal:not(.hidden)');
  await page.waitForSelector('text=Password updated');
  await page.fill('#authEmail', email);
  await page.fill('#authPassword', 'new-pass-123');
  await page.click('#authForm button:has-text("Continue")');
  await page.waitForFunction(() => document.getElementById('authLabel').textContent.includes('E2E'));
  check('password reset works and the new password logs in', true);

  // ---- Admin portal ----
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  admin.on('pageerror', (e) => pageErrors.push(e.message));
  await admin.goto(`${BASE}/admin`);
  await admin.fill('#adminToken', ADMIN);
  await admin.click('header button:has-text("Connect")');
  await admin.waitForSelector('#productRows tr');
  const row = admin.locator('#productRows tr[data-id="P-001"]');
  await row.locator('[data-f="price"]').fill('9000');
  await row.getByRole('button', { name: 'Save' }).click();
  await admin.waitForSelector('text=P-001 saved');
  const shown = await admin.locator('#productRows tr[data-id="P-001"] [data-f="price"]').inputValue();
  check('admin updates a product price', shown === '9000', shown);

  const orderCard = admin.locator('#orders > div', { hasText: orderId });
  await admin.waitForSelector(`#orders >> text=${orderId}`);
  check('admin view shows the cancelled order with no further actions',
    (await orderCard.count()) === 1 && (await orderCard.getByRole('button').count()) === 0);

  await admin.locator('#orders > div').first().screenshot({ path: '/tmp/e2e-admin-order.png' });
  await page.screenshot({ path: '/tmp/e2e-storefront.png', fullPage: false });

  check('no JavaScript errors in the browser', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
} catch (err) {
  check('e2e run completed', false, err.message.split('\n')[0]);
  if (typeof page !== 'undefined') {
    await page.screenshot({ path: '/tmp/e2e-fail.png' }).catch(() => {});
    console.log('lookup text:', (await page.locator('#lookupResult').innerText().catch(() => 'n/a')).slice(0, 400));
    console.log('toast:', await page.locator('#toast').innerText().catch(() => 'n/a'));
  }
} finally {
  if (browser) await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}