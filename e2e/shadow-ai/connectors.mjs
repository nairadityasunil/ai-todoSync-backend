// Shadow AI connectors and enforcement hooks against the real API, with a stub identity provider.
import mongoose from 'mongoose';
import { generateKeyPairSync } from 'node:crypto';
import { start, state } from './idp-stub.mjs';
const API = (process.env.API_URL ?? 'http://localhost:4000/api');
const PORTAL = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', origin: (process.env.APP_URL ?? 'http://localhost:5173'), 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const call = async (method, path, { token, body, headers } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { ...PORTAL, authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const issues = [];
const step = async (name, fn) => { try { await fn(); console.log(`✓ ${name}`); } catch (e) { issues.push(name); console.log(`✗ ${name}\n    ${String(e?.message ?? e).slice(0, 900)}`); } };
const expect = (c, m) => { if (!c) throw new Error(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 900)); };
const S = '/shadow-ai';
const stub = await start();
await mongoose.connect((process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/'), { dbName: 'pristine' });
const db = mongoose.connection.db;
const login = async (email) => (await call('POST', '/auth/login', { body: { email, password: 'Password123!' } })).body.data;
const token = (await login('qa@example.com')).token;
const stamp = Date.now().toString(36);
for (const c of ['shadowtools', 'shadowsightings', 'shadowtokens', 'shadowrequests', 'shadowsettings', 'shadowconnectors']) await db.collection(c).deleteMany({});
await call('POST', '/auth/register', { body: { email: `cmember-${stamp}@example.com`, password: 'Password123!', name: 'Plain' } });
const member = await login(`cmember-${stamp}@example.com`);
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const myWs = (await db.collection('workspacemembers').find({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId;
const mid = (await db.collection('users').findOne({ email: `cmember-${stamp}@example.com` }))._id;
await db.collection('workspacemembers').updateOne({ userId: mid, workspaceId: myWs }, { $setOnInsert: { userId: mid, workspaceId: myWs, role: 'MEMBER', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
const ws = `?workspaceId=${myWs}`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const saKey = JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: pem });
let gId, mId, azId, awsId;
const tools = async (q = '') => (await call('GET', `${S}/tools${ws}${q}`, { token })).body.data;

await step('members cannot see or add connectors', async () => {
  expect((await call('GET', `${S}/connectors${ws}`, { token: member.token })).status === 403);
  expect((await call('POST', `${S}/connectors${ws}`, { token: member.token, body: { type: 'google_workspace' } })).status === 403);
});
await step('bad input is refused with a reason', async () => {
  let r = await call('POST', `${S}/connectors${ws}`, { token, body: { type: 'nope' } });
  expect(r.status === 400, r.body);
  r = await call('POST', `${S}/connectors${ws}`, { token, body: { type: 'google_workspace', adminEmail: 'admin@corp.com', serviceAccountKey: 'not json' } });
  expect(r.status === 400 && /not valid JSON/.test(r.body.error?.message ?? r.body.message ?? JSON.stringify(r.body)), r.body);
  r = await call('POST', `${S}/connectors${ws}`, { token, body: { type: 'google_workspace', adminEmail: 'x', serviceAccountKey: saKey } });
  expect(r.status === 400, r.body);
});
await step('Google: a provider that refuses is reported, nothing is saved', async () => {
  state.googleBroken = true;
  const r = await call('POST', `${S}/connectors${ws}`, { token, body: { type: 'google_workspace', adminEmail: 'admin@corp.com', serviceAccountKey: saKey } });
  state.googleBroken = false;
  expect(r.status === 400 && /Could not connect/.test(JSON.stringify(r.body)) && /unauthorized/.test(JSON.stringify(r.body)), r.body);
  expect(!JSON.stringify(r.body).includes('PRIVATE KEY'), 'no key in the error');
  expect(await db.collection('shadowconnectors').countDocuments({}) === 0, 'nothing saved');
});
await step('Google: connect, find AI apps with the people who granted them, ignore non-AI apps', async () => {
  const r = await call('POST', `${S}/connectors${ws}`, { token, body: { type: 'google_workspace', name: 'Corp Google', adminEmail: 'admin@corp.com', serviceAccountKey: saKey } });
  expect(r.status === 201 && r.body.data.lastStatus === 'ok' && r.body.data.lastUsers === 2 && r.body.data.lastSignals === 3, r.body);
  gId = r.body.data.id;
  expect(!JSON.stringify(r.body).includes('BEGIN') && !('credentials' in r.body.data), 'credentials not returned');
  const stored = await db.collection('shadowconnectors').findOne({});
  expect(!stored.credentials.includes('PRIVATE KEY') && !stored.credentials.includes('sa@proj'), 'credentials stored encrypted');
  const t = await tools();
  const names = t.map((x) => x.name);
  expect(names.includes('Otter.ai') && names.includes('Fireflies.ai') && !names.includes('Slack'), names);
  const f = t.find((x) => x.name === 'Fireflies.ai');
  expect(f.users === 1 && f.hasBroadGrant && f.sources.includes('oauth'), f);
  const list = (await call('GET', `${S}/connectors${ws}`, { token })).body.data;
  expect(list.length === 1 && list[0].account === 'admin@corp.com', list);
});
await step('Microsoft: wrong secret refused without echoing it; right secret works', async () => {
  const bad = { type: 'microsoft_entra', tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'app', clientSecret: 'wrong-secret-9' };
  let r = await call('POST', `${S}/connectors${ws}`, { token, body: bad });
  expect(r.status === 400 && /Invalid client secret/.test(JSON.stringify(r.body)) && !JSON.stringify(r.body).includes('wrong-secret-9'), r.body);
  r = await call('POST', `${S}/connectors${ws}`, { token, body: { ...bad, clientSecret: 'right-secret-1' } });
  expect(r.status === 201 && r.body.data.lastSignals === 2, r.body);
  mId = r.body.data.id;
  const c = (await tools('&q=chatgpt'))[0];
  expect(c && c.users === 1 && c.hasBroadGrant, c);
  expect(!(await tools()).some((x) => x.name === 'Microsoft Teams'), 'Teams is not AI');
});
await step('a decision survives a sync, and syncing twice does not inflate counts', async () => {
  const o = (await tools('&q=otter'))[0];
  expect((await call('POST', `${S}/tools/${o.id}/decision${ws}`, { token, body: { status: 'prohibited', reason: 'Records meetings without consent' } })).status === 200);
  for (let i = 0; i < 2; i++) expect((await call('POST', `${S}/connectors/${gId}/sync${ws}`, { token })).body.data.lastStatus === 'ok');
  const after = (await tools('&status=prohibited&q=otter'))[0];
  expect(after.status === 'prohibited' && after.users === 1, after);
  const detail = (await call('GET', `${S}/tools/${o.id}${ws}`, { token })).body.data;
  expect(detail.sightings.length === 1 && detail.sightings[0].count === 1, detail.sightings);
});
await step('a revoked grant disappears at the next sync', async () => {
  state.revoked = true;
  expect((await call('POST', `${S}/connectors/${gId}/sync${ws}`, { token })).body.data.lastSignals === 0);
  state.revoked = false;
  const o = (await tools('&q=otter&status=prohibited'))[0];
  expect(o.users === 0 && o.status === 'prohibited', o);
});
await step('a broken provider marks the connector failed but keeps what was found', async () => {
  state.googleBroken = true;
  const r = await call('POST', `${S}/connectors/${gId}/sync${ws}`, { token });
  state.googleBroken = false;
  expect(r.status === 200 && r.body.data.lastStatus === 'error' && /unauthorized/.test(r.body.data.lastError), r.body);
  expect((await tools()).length >= 3, 'tools kept');
  const ok = await call('POST', `${S}/connectors/${gId}/sync${ws}`, { token });
  expect(ok.body.data.lastStatus === 'ok' && ok.body.data.lastError === '', ok.body);
});
await step('the hourly job syncs connectors', async () => {
  await db.collection('shadowconnectors').updateOne({}, { $set: { lastSyncAt: new Date(0), lastStatus: 'never' } });
  expect((await call('POST', `${S}/monitor/run${ws}`, { token })).status === 200);
  expect((await call('GET', `${S}/connectors${ws}`, { token })).body.data.every((c) => c.lastStatus === 'ok'));
});
let tok;
await step('gateway hook: asks about a host, gets allow or deny with the alternative; use is recorded', async () => {
  const t = (await call('POST', `${S}/tokens${ws}`, { token, body: { name: 'gateway' } })).body.data.token; tok = t;
  const ask = (host, user) => call('GET', `${S}/ingest/decision?host=${encodeURIComponent(host)}${user ? `&user=${user}` : ''}`, { headers: { 'x-shadow-ai-token': t } });
  const o = (await tools('&q=otter&status=prohibited'))[0];
  await call('POST', `${S}/tools/${o.id}/decision${ws}`, { token, body: { status: 'prohibited', reason: 'Records meetings without consent', alternative: 'Built-in meeting notes' } });
  let r = await ask('https://otter.ai/home', 'dave@corp.com');
  expect(r.status === 200 && r.body.data.allowed === false && r.body.data.status === 'prohibited' && r.body.data.alternative === 'Built-in meeting notes', r.body);
  r = await ask('intranet.corp.com');
  expect(r.body.data.known === false && r.body.data.allowed === true, r.body);
  r = await ask('claude.ai', 'dave@corp.com');
  expect(r.body.data.known === true && r.body.data.allowed === true && r.body.data.status === 'unreviewed', r.body);
  const seen = (await call('GET', `${S}/tools/${o.id}${ws}`, { token })).body.data.sightings.some((s) => s.user === 'dave@corp.com' && s.source === 'network');
  expect(seen, 'the check counts as use');
  expect((await call('GET', `${S}/ingest/decision`, { headers: { 'x-shadow-ai-token': t } })).status === 400, 'host required');
  expect((await call('GET', `${S}/ingest/decision?host=otter.ai`)).status === 401, 'no token');
});
await step('blocklist feed returns only prohibited domains, for a token', async () => {
  const r = await fetch(`${API}${S}/ingest/blocklist`, { headers: { 'x-shadow-ai-token': tok } });
  const text = await r.text();
  expect(r.status === 200 && text.trim() === 'otter.ai', text);
  expect((await fetch(`${API}${S}/ingest/blocklist`)).status === 401);
});
await step('Azure: finds Azure OpenAI resources, ignores other AI services', async () => {
  const base = { type: 'azure_ai', tenantId: '11111111-1111-1111-1111-111111111111', clientId: 'app', subscriptionId: '22222222-2222-2222-2222-222222222222' };
  let r = await call('POST', `${S}/connectors${ws}`, { token, body: { ...base, clientSecret: 'wrong-secret-9' } });
  expect(r.status === 400 && !JSON.stringify(r.body).includes('wrong-secret-9'), r.body);
  r = await call('POST', `${S}/connectors${ws}`, { token, body: { ...base, clientSecret: 'right-secret-1' } });
  expect(r.status === 201 && r.body.data.lastSignals === 1, r.body);
  const t = (await tools('&q=azure openai'))[0];
  expect(t && t.sources.includes('cloud') && t.users === 0, t);
  const d = (await call('GET', `${S}/tools/${t.id}${ws}`, { token })).body.data;
  expect(d.sightings.some((s) => /oai-prod \(OpenAI, swedencentral\)/.test(s.detail)), d.sightings);
  azId = r.body.data.id;
});
await step('AWS: signed calls find Bedrock and SageMaker resources; a wrong key is refused', async () => {
  const base = { type: 'aws_ai', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', regions: 'us-east-1' };
  let r = await call('POST', `${S}/connectors${ws}`, { token, body: { ...base, accessKeyId: 'AKIAWRONGWRONGWRONG1', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } });
  expect(r.status === 400 && /security token/.test(JSON.stringify(r.body)), r.body);
  r = await call('POST', `${S}/connectors${ws}`, { token, body: { ...base, secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' } });
  expect(r.status === 201 && r.body.data.lastSignals === 2, r.body);
  expect(!JSON.stringify(r.body).includes('wJalrXUtnFEMI'), 'secret not returned');
  expect(!JSON.stringify(await db.collection('shadowconnectors').find({}).toArray()).includes('wJalrXUtnFEMI'), 'secret stored encrypted');
  const names = (await tools()).map((x) => x.name);
  expect(names.includes('Amazon Bedrock') && names.includes('Amazon SageMaker'), names);
  awsId = r.body.data.id;
});
await step('remove a connector', async () => {
  expect((await call('DELETE', `${S}/connectors/${mId}${ws}`, { token })).status === 200);
  expect((await call('GET', `${S}/connectors${ws}`, { token })).body.data.length === 3);
  expect((await call('DELETE', `${S}/connectors/${mId}${ws}`, { token })).status === 404);
});
stub.close();
console.log(issues.length ? `\n${issues.length} failed: ${issues.join('; ')}` : '\nAll connector checks passed');
await mongoose.disconnect();
process.exit(issues.length ? 1 : 0);
