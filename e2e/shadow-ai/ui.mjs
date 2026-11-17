// Shadow AI in the portal against the real backend.
import mongoose from 'mongoose';
import { start as startStub } from './idp-stub.mjs';
import { generateKeyPairSync } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const API = (process.env.API_URL ?? 'http://localhost:4000/api');
const APP = (process.env.APP_URL ?? 'http://localhost:5173');
const OUT = process.env.SCREENSHOT_DIR ?? '/tmp';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const call = async (method, path, { body } = {}) => { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
await mongoose.connect((process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/'), { dbName: 'pristine' });
const db = mongoose.connection.db;
for (const c of ['shadowtools', 'shadowsightings', 'shadowtokens', 'shadowrequests', 'shadowsettings', 'shadowconnectors']) await db.collection(c).deleteMany({});
const stamp = Date.now().toString(36);
await call('POST', '/auth/register', { body: { email: `ui-member-${stamp}@example.com`, password: 'Password123!', name: 'Ui Member' } });
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const myWs = (await db.collection('workspacemembers').find({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId;
const mem = await db.collection('users').findOne({ email: `ui-member-${stamp}@example.com` });
await db.collection('workspacemembers').updateOne({ userId: mem._id, workspaceId: myWs }, { $setOnInsert: { userId: mem._id, workspaceId: myWs, role: 'MEMBER', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
await db.collection('workspacemembers').deleteMany({ userId: mem._id, workspaceId: { $ne: myWs } });

const stub = await startStub();
const browser = await chromium.launch();
const issues = [];
const mk = async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent: UA, acceptDownloads: true });
  page.on('response', async (r) => { if (r.url().includes(':4000/api') && r.status() >= 400) { const line = `HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`; if (!/GET \/api\/(engagement|guides|surveys)/.test(line) && !(page.__allow ?? []).some((e) => e.test(line))) issues.push(line); } });
  page.on('pageerror', (e) => issues.push('PAGEERROR ' + String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Socket|WebSocket/.test(m.text())) issues.push('CONSOLE ' + m.text().slice(0, 200)); });
  return page;
};
const login = async (page, email) => {
  await page.goto(`${APP}/login`);
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.locator('input[name=password]').fill('Password123!');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL(/dashboard/, { timeout: 20000 });
};
const stepFor = (page) => async (name, fn) => { const b = issues.length; try { await fn(); } catch (e) { issues.push(`STEP FAILED ${name}: ${String(e).split('\n')[0].slice(0, 300)}`); await page.screenshot({ path: `/tmp/shadow-ai-fail-${name.replace(/\W+/g, '-').slice(0, 40)}.png` }).catch(() => {}); } const f = issues.slice(b); console.log(`${f.length ? '✗' : '✓'} ${name}${f.length ? '\n    ' + f.join('\n    ') : ''}`); };

const page = await mk();
const step = stepFor(page);
await login(page, 'qa@example.com');
try {
  await step('Shadow AI tab opens with an empty state that says what to do', async () => {
    await page.goto(`${APP}/ai-governance/shadow-ai`);
    await page.getByText('No AI tools discovered yet').waitFor({ timeout: 15000 });
    await page.getByText('Nothing has been found yet, which is not the same as nothing being used').waitFor();
  });
  await step('Import a network log: result sentence is accurate', async () => {
    await page.getByRole('button', { name: 'Add a source' }).click();
    await page.getByLabel('Log contents').fill(['time,user,host,bytes_out,uploads', '2026-11-10T09:00:00Z,ada@corp.com,chatgpt.com,4096,1', '2026-11-10T09:05:00Z,bob@corp.com,chat.openai.com,2048,0', '2026-11-11T10:00:00Z,ada@corp.com,otter.ai,100,0', '2026-11-11T10:00:00Z,ada@corp.com,intranet.corp.com,10,0'].join('\n'));
    await page.getByRole('button', { name: 'Import log' }).click();
    await page.getByTestId('shadow-log-result').getByText('3 requests matched AI tools, 2 new tools found, 1 line ignored.').waitFor({ timeout: 10000 });
  });
  await step('Scan code: library and key found, key never shown whole', async () => {
    const key = 'sk-ant-api03-' + 'Q'.repeat(40);
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync('/tmp/shadow-scan-');
    fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ dependencies: { openai: '^4' } }));
    fs.writeFileSync(`${dir}/config.ts`, `export const k = "${key}";`);
    await page.getByTestId('shadow-scan-input').setInputFiles(dir);
    const res = page.getByTestId('shadow-scan-result');
    await res.getByText('2 files scanned: 1 AI library, 1 key.').waitFor({ timeout: 10000 });
    await res.getByText('Rotate every key listed').waitFor();
    const text = await res.innerText();
    if (text.includes(key) || text.includes('QQQQQQQQ')) throw new Error('key leaked into the page');
  });
  await step('Create a token: shown once, then only its prefix', async () => {
    await page.getByLabel('Name', { exact: true }).fill('Zscaler nightly');
    await page.getByRole('button', { name: 'Create token' }).click();
    const fresh = page.getByTestId('shadow-token-fresh');
    await fresh.getByText('Copy this token now').waitFor();
    const tok = (await fresh.locator('code').innerText()).trim();
    if (!/^sai_[a-f0-9]{48}$/.test(tok)) throw new Error('token shape ' + tok);
    await fresh.getByRole('button', { name: 'I have copied it' }).click();
    await page.getByTestId('shadow-token-fresh').waitFor({ state: 'detached' });
    if ((await page.getByTestId('shadow-sources').innerText()).includes(tok)) throw new Error('token still on page');
    await page.getByTestId('shadow-sources').getByText(tok.slice(0, 8)).first().waitFor();
    await page.screenshot({ path: `${OUT}/shadow-sources.png` });
  });
  await step('Connect Microsoft Entra from the portal: wrong secret shows the reason, right secret finds apps', async () => {
    await page.getByTestId('shadow-ai').getByRole('tab', { name: 'Sources' }).click();
    const card = page.getByTestId('shadow-connectors');
    await card.getByRole('button', { name: 'Connect Microsoft Entra' }).click();
    const form = page.getByTestId('shadow-connector-form');
    await form.getByLabel('Tenant ID or domain').fill('11111111-1111-1111-1111-111111111111');
    await form.getByLabel('Client ID').fill('app');
    await form.getByLabel('Client secret').fill('wrong-secret-9');
    page.__allow = [/POST \/api\/shadow-ai\/connectors/];
    await form.getByRole('button', { name: 'Connect' }).click();
    await form.getByRole('alert').getByText(/Invalid client secret/).waitFor({ timeout: 15000 });
    if ((await form.innerText()).includes('wrong-secret-9')) throw new Error('secret echoed');
    await form.getByLabel('Client secret').fill('right-secret-1');
    await form.getByRole('button', { name: 'Connect' }).click();
    await card.getByText('11111111-1111-1111-1111-111111111111').waitFor({ timeout: 15000 });
    await card.getByText(/Synced .* 1 person, 2 grants/).waitFor();
    page.__allow = [];
    issues.splice(0, issues.length, ...issues.filter((i) => !/shadow-ai\/connectors/.test(i)));
  });
  await step('Connect Google Workspace with a key file', async () => {
    const card = page.getByTestId('shadow-connectors');
    await card.getByRole('button', { name: 'Connect Google Workspace' }).click();
    const form = page.getByTestId('shadow-connector-form');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    await form.getByLabel('Admin email to act as').fill('admin@corp.com');
    await form.getByLabel('Service account key (JSON) contents').fill(key);
    await form.getByRole('button', { name: 'Connect' }).click();
    await card.getByText('admin@corp.com').waitFor({ timeout: 15000 });
    await card.getByText(/2 people, 3 grants/).waitFor();
    await page.screenshot({ path: `${OUT}/shadow-connectors.png` });
  });
  await step('Connect Azure AI and AWS AI from the portal and see the AI resources found', async () => {
    const card = page.getByTestId('shadow-connectors');
    await card.getByRole('button', { name: 'Connect Azure AI' }).click();
    let form = page.getByTestId('shadow-connector-form');
    await form.getByLabel('Tenant ID or domain').fill('11111111-1111-1111-1111-111111111111');
    await form.getByLabel('Subscription ID').fill('22222222-2222-2222-2222-222222222222');
    await form.getByLabel('Client ID').fill('app');
    await form.getByLabel('Client secret').fill('right-secret-1');
    await form.getByRole('button', { name: 'Connect' }).click();
    await card.getByText(/Synced .*1 AI resource/).first().waitFor({ timeout: 15000 });
    await card.getByRole('button', { name: 'Connect AWS AI' }).click();
    form = page.getByTestId('shadow-connector-form');
    await form.getByLabel('Access key ID').fill('AKIAIOSFODNN7EXAMPLE');
    await form.getByLabel('Secret access key').fill('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    await form.getByLabel(/Regions/).fill('us-east-1');
    await form.getByRole('button', { name: 'Connect' }).click();
    await card.getByText(/Synced .*2 AI resources/).first().waitFor({ timeout: 15000 });
    await page.getByTestId('shadow-extension').getByText('Browser extension').waitFor();
    await page.screenshot({ path: `${OUT}/shadow-connectors.png` });
  });
  await step('Sync now and Run check now report what happened', async () => {
    await page.getByTestId('shadow-connectors').getByRole('button', { name: 'Sync now' }).first().click();
    await page.getByText(/Synced: \d+ grants/).first().waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Run check now' }).click();
    await page.getByText(/Check done: \d+ new alerts?, \d+ new tasks?/).first().waitFor({ timeout: 15000 });
  });
  await step('Remove a connector', async () => {
    const card = page.getByTestId('shadow-connectors');
    await card.getByRole('button', { name: /Remove Microsoft Entra/ }).click();
    await card.getByRole('button', { name: /Remove Microsoft Entra/ }).waitFor({ state: 'detached', timeout: 10000 });
  });
  await step('Overview shows the numbers and what to review first', async () => {
    await page.getByTestId('shadow-ai').getByRole('tab', { name: 'Overview' }).click();
    const stats = page.getByTestId('shadow-stats');
    await stats.getByText('AI tools found').waitFor();
    const t = await stats.innerText();
    if (!/AI tools found \d+ found so far/.test(t.replace(/\s+/g, ' '))) throw new Error('count missing: ' + t);
    await page.getByText('not tied to a person').first().waitFor();
    await page.getByText('Review first').waitFor();
    await page.getByText('Exposed AI keys').waitFor();
    await page.screenshot({ path: `${OUT}/shadow-overview.png` });
  });
  await step('Open a tool, see why it scored, and the decision button waits for a reason', async () => {
    await page.getByRole('tab', { name: 'Tools found' }).click();
    const row = page.getByTestId('shadow-tools').getByRole('row', { name: /ChatGPT/ });
    await row.getByRole('button', { name: 'Open' }).click();
    const dlg = page.getByTestId('shadow-tool');
    await dlg.getByText('Why this risk score').waitFor();
    await dlg.getByText(/\d people use it/).waitFor();
    const save = dlg.getByRole('button', { name: 'Save decision' });
    if (!(await save.isDisabled())) throw new Error('decision enabled without a reason');
    await dlg.getByLabel('Reason').fill('Only the enterprise tenant is covered');
    await dlg.getByLabel('Decision').or(dlg.getByRole('combobox', { name: 'Decision' })).first().click().catch(() => {});
  });
  await step('Restrict the tool with conditions and an alternative', async () => {
    const dlg = page.getByTestId('shadow-tool');
    await page.getByRole('listbox').last().getByRole('option', { name: 'Restricted' }).click();
    await dlg.getByLabel('Conditions').fill('Public and internal data only');
    await dlg.getByLabel('Use this instead').fill('Claude (company account)');
    await dlg.getByRole('button', { name: 'Save decision' }).click();
    await dlg.getByText('Restricted by').waitFor({ timeout: 10000 });
    await dlg.getByText('Use instead: Claude (company account).').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  });
  await step('Prohibit another tool; the row shows its status', async () => {
    const row = page.getByTestId('shadow-tools').getByRole('row', { name: /Otter/ });
    await row.getByRole('button', { name: 'Open' }).click();
    const dlg = page.getByTestId('shadow-tool');
    await dlg.getByLabel('Reason').fill('Records meetings without consent');
    await dlg.getByLabel('Decision').or(dlg.getByRole('combobox', { name: 'Decision' })).first().click();
    await page.getByRole('listbox').last().getByRole('option', { name: 'Prohibited' }).click();
    await dlg.getByRole('button', { name: 'Save decision' }).click();
    await dlg.getByText('Prohibited by').waitFor({ timeout: 10000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await page.getByTestId('shadow-tools').getByRole('row', { name: /Otter/ }).getByText('Prohibited').waitFor();
    await page.screenshot({ path: `${OUT}/shadow-tools.png` });
  });
  await step('Policy: blocklist downloads with only prohibited domains', async () => {
    await page.getByRole('tab', { name: 'Policy' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Blocklist (.txt)' }).click()]);
    const path = await dl.path();
    const text = (await import('node:fs')).readFileSync(path, 'utf8');
    if (!text.split('\n').includes('otter.ai') || text.includes('chatgpt.com')) throw new Error('blocklist wrong: ' + text);
  });
  await step('Policy: amnesty and message save; bad review days are refused', async () => {
    const d = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    await page.getByLabel('Amnesty until').fill(d);
    await page.getByLabel('Message to staff').fill('Tell us what you use. No blame.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Policy saved').first().waitFor({ timeout: 10000 });
    page.__allow = [/POST|PATCH \/api\/shadow-ai\/settings/];
    await page.getByLabel('Review within (days)').fill('500');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').getByText(/between 1 and 90/).first().waitFor({ timeout: 10000 });
    page.__allow = [];
    issues.splice(0, issues.length, ...issues.filter((i) => !/shadow-ai\/settings/.test(i)));
    await page.getByLabel('Review within (days)').fill('14');
  });
  await step('Declare a tool as admin: coaching shows status and the alternative', async () => {
    await page.getByRole('button', { name: 'Declare an AI tool' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Which tool?').fill('ChatGPT');
    await dlg.getByLabel('What do you use it for?').fill('Drafting customer replies');
    await dlg.getByText('Customer data').click();
    await dlg.getByRole('button', { name: 'Send' }).click();
    const done = page.getByTestId('shadow-declared');
    await done.getByText('An amnesty is running').waitFor({ timeout: 10000 });
    await done.getByText('Use instead: Claude (company account).').waitFor();
    await done.getByText('Tell us what you use. No blame.').waitFor();
    await done.getByRole('button', { name: 'Done' }).click();
  });
  await step('Requests: admin declines a declaration with a note; the note is required', async () => {
    await page.getByRole('tab', { name: /Requests/ }).click();
    const list = page.getByTestId('shadow-requests');
    await list.getByText('Drafting customer replies').waitFor();
    await list.getByRole('button', { name: 'Decline' }).first().click();
    const dlg = page.getByRole('dialog');
    const send = dlg.getByRole('button', { name: 'Send decision' });
    if (!(await send.isDisabled())) throw new Error('send enabled without note');
    await dlg.getByLabel('Note').fill('Please use the company account');
    await send.click();
    await list.getByText('Please use the company account').waitFor({ timeout: 10000 });
  });
  await step('Compliance page shows the shadow AI controls', async () => {
    await page.goto(`${APP}/agents`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Compliance' }).click();
    await page.getByText('AI tools found in use are reviewed within the review window').first().waitFor({ timeout: 20000 });
    await page.getByText('Prohibited AI tools and exposed AI keys are not in use').first().waitFor();
    await page.screenshot({ path: `${OUT}/shadow-compliance.png` });
  });
} finally {
  await page.close();
}

// A plain member sees only the declare flow.
const mpage = await mk();
const mstep = stepFor(mpage);
mpage.__allow = [/GET \/api\/shadow-ai\/overview/, /GET \/api\/agents\/incidents/];
try {
  await login(mpage, `ui-member-${stamp}@example.com`);
  await mstep('Member sees the declare flow, not the admin views', async () => {
    await mpage.goto(`${APP}/ai-governance/shadow-ai`);
    await mpage.getByTestId('shadow-member').getByText('Tell us about an AI tool you use').waitFor({ timeout: 15000 });
    if (await mpage.getByRole('tab', { name: 'Sources' }).count()) throw new Error('admin tabs visible to a member');
    await mpage.screenshot({ path: `${OUT}/shadow-member.png` });
  });
  await mstep('Member declares a tool and sees only their own note', async () => {
    await mpage.getByRole('button', { name: 'Declare an AI tool' }).click();
    const dlg = mpage.getByRole('dialog');
    await dlg.getByLabel('Which tool?').fill('Perplexity');
    await dlg.getByLabel('What do you use it for?').fill('Researching competitors');
    await dlg.getByRole('button', { name: 'Send' }).click();
    await mpage.getByTestId('shadow-declared').getByRole('button', { name: 'Done' }).click();
    const list = mpage.getByTestId('shadow-requests');
    await list.getByText('Perplexity').waitFor({ timeout: 10000 });
    if (await list.getByText('Drafting customer replies').count()) throw new Error("member sees someone else's request");
    await list.getByRole('button', { name: 'Withdraw' }).click();
    await list.getByText('withdrawn').waitFor({ timeout: 10000 });
  });
} finally {
  await mpage.close();
}
stub.close();
await browser.close();
await mongoose.disconnect();
console.log(issues.length ? `\n${issues.length} issue(s)` : '\nAll shadow AI UI checks passed');
process.exit(issues.length ? 1 : 0);
