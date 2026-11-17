// The browser extension in a real Chromium against the real backend. AI hostnames are mapped to a local page.
import mongoose from 'mongoose';
import http from 'node:http';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const EXT = path.resolve(process.env.EXTENSION_DIR ?? 'extensions/shadow-ai');
const call = async (method, p, { token, body } = {}) => {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { 'user-agent': 'Mozilla/5.0 Chrome/130.0', origin: process.env.APP_URL ?? 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site', authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
};
const issues = [];
const step = async (name, fn) => { try { await fn(); console.log(`✓ ${name}`); } catch (e) { issues.push(name); console.log(`✗ ${name}\n    ${String(e?.message ?? e).slice(0, 700)}`); } };
const expect = (c, m) => { if (!c) throw new Error(String(m)); };

await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const db = mongoose.connection.db;
for (const c of ['shadowtools', 'shadowsightings', 'shadowtokens', 'shadowsettings']) await db.collection(c).deleteMany({});
await db.collection('agentalerts').deleteMany({ type: 'shadow_ai_sensitive' });
const login = (await call('POST', '/auth/login', { body: { email: 'qa@example.com', password: 'Password123!' } })).data;
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const ws = (await db.collection('workspacemembers').find({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId;
const q = `?workspaceId=${ws}`;
const tok = (await call('POST', `/shadow-ai/tokens${q}`, { token: login.token, body: { name: 'extension test' } })).data.token;
// Seed the tools so each has a status.
await call('POST', `/shadow-ai/import/signals${q}`, { token: login.token, body: { source: 'network', signals: [{ target: 'otter.ai' }, { target: 'chatgpt.com' }, { target: 'claude.ai' }] } });
const toolId = async (name) => (await call('GET', `/shadow-ai/tools${q}&q=${name}`, { token: login.token })).data[0].id;
await call('POST', `/shadow-ai/tools/${await toolId('otter')}/decision${q}`, { token: login.token, body: { status: 'prohibited', reason: 'Records meetings without consent', alternative: 'Built-in meeting notes' } });
await call('POST', `/shadow-ai/tools/${await toolId('chatgpt')}/decision${q}`, { token: login.token, body: { status: 'restricted', reason: 'Enterprise tenant only', conditions: 'Public and internal data only', alternative: 'Claude (company account)' } });
await call('POST', `/shadow-ai/tools/${await toolId('claude')}/decision${q}`, { token: login.token, body: { status: 'sanctioned', reason: 'Enterprise contract in place' } });

console.log('seeded');
const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>AI site</title><textarea id="box" rows="4" cols="60"></textarea>'); }).listen(18099);
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new', '--host-resolver-rules=MAP otter.ai 127.0.0.1:18099, MAP chatgpt.com 127.0.0.1:18099, MAP claude.ai 127.0.0.1:18099, MAP www.otter.ai 127.0.0.1:18099'],
});
console.log('launched');
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
console.log('sw ready');
const extId = new URL(sw.url()).host;
// The service worker sleeps between events, so talk to the extension through its options page, which is always awake.
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
const ext = (fn, arg) => opt.evaluate(fn, arg);
await ext(([server, token]) => chrome.storage.sync.set({ server, token, user: 'ext-user@corp.com' }), [API.replace(/\/api$/, ''), tok]);
console.log('configured');
await new Promise((r) => setTimeout(r, 1500));

await step('the prohibited site is blocked before it loads, with the reason and the alternative', async () => {
  const p = await ctx.newPage();
  await p.goto('http://otter.ai/home').catch(() => {});
  await p.waitForURL(new RegExp(`chrome-extension://${extId}/blocked.html`), { timeout: 15000 });
  await p.getByText('otter.ai is not allowed').waitFor();
  await p.getByText('Use this instead: Built-in meeting notes').waitFor({ timeout: 10000 }).catch(async () => { throw new Error('alternative missing on block page: ' + (await p.innerText('body'))); });
  await p.close();
});
await step('a restricted site loads and the toolbar shows its status; the visit is recorded against the person', async () => {
  const p = await ctx.newPage();
  await p.goto('http://chatgpt.com/');
  await new Promise((r) => setTimeout(r, 1500));
  const site = await ext(() => chrome.storage.local.get('site:chatgpt.com'));
  const d = site['site:chatgpt.com'];
  expect(d && d.status === 'restricted' && d.allowed === true && d.alternative === 'Claude (company account)', JSON.stringify(site));
  const t = (await call('GET', `/shadow-ai/tools/${await toolId('chatgpt')}${q}`, { token: login.token })).data;
  expect(t.sightings.some((s) => s.user === 'ext-user@corp.com'), 'visit recorded');
  await p.close();
});
await step('pasting ordinary text works as normal', async () => {
  const p = await ctx.newPage();
  await p.goto('http://claude.ai/');
  await p.evaluate(() => { const b = document.getElementById('box'); b.focus(); });
  await ext(() => navigator.clipboard?.writeText?.('x').catch(() => {}));
  await p.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'Summarise the lunch menu for Friday please');
    document.getElementById('box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => document.getElementById('box').value.includes('lunch menu'), null, { timeout: 8000 });
  await p.close();
});
await step('pasting a card number into a restricted tool is stopped with a message, and not typed in', async () => {
  const p = await ctx.newPage();
  await p.goto('http://chatgpt.com/');
  await p.evaluate(() => document.getElementById('box').focus());
  await p.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'customer card 4111 1111 1111 1111 expires soon');
    document.getElementById('box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.locator('#pristine-shadow-banner').waitFor({ timeout: 8000 });
  const banner = await p.locator('#pristine-shadow-banner').innerText();
  expect(/Not pasted/.test(banner) && /payment card/i.test(banner) && /Claude \(company account\)/.test(banner), banner);
  expect(!(await p.inputValue('#box')).includes('4111'), 'the card number must not have been pasted');
  await p.close();
});
await step('pasting an email into a sanctioned tool warns but still pastes', async () => {
  const p = await ctx.newPage();
  await p.goto('http://claude.ai/');
  await p.evaluate(() => document.getElementById('box').focus());
  await p.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'ask jo@example.com about the budget');
    document.getElementById('box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.locator('#pristine-shadow-banner').waitFor({ timeout: 8000 });
  expect(/Heads up/.test(await p.locator('#pristine-shadow-banner').innerText()), 'warning shown');
  await p.waitForFunction(() => document.getElementById('box').value.includes('budget'), null, { timeout: 8000 });
  await p.close();
});
await step('with the server unreachable, pasting still works (the extension never gets in the way)', async () => {
  await ext(() => chrome.storage.sync.set({ server: 'http://127.0.0.1:9' }));
  const p = await ctx.newPage();
  await p.goto('http://claude.ai/');
  await p.evaluate(() => document.getElementById('box').focus());
  await p.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'card 4111 1111 1111 1111');
    document.getElementById('box').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await p.waitForFunction(() => document.getElementById('box').value.includes('4111'), null, { timeout: 8000 });
  await p.close();
  await ext(([server]) => chrome.storage.sync.set({ server }), [API.replace(/\/api$/, '')]);
});
await step('the server saw the sensitive paste as counts only', async () => {
  const stored = JSON.stringify(await db.collection('shadowsightings').find({}).toArray());
  expect(!stored.includes('4111') && !stored.includes('jo@example.com'), 'text must not be stored');
  const t = (await call('GET', `/shadow-ai/tools${q}&q=chatgpt`, { token: login.token })).data[0];
  expect(t.sensitive >= 1, JSON.stringify(t));
});
await ctx.close();
page.close();
await mongoose.disconnect();
console.log(issues.length ? `\n${issues.length} failed: ${issues.join('; ')}` : '\nAll extension checks passed');
process.exit(issues.length ? 1 : 0);
