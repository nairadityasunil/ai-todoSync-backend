// A plain member can open the activity timeline and sees only what is scoped to them; an outsider cannot.
import mongoose from 'mongoose';
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const PORTAL = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', origin: process.env.APP_URL ?? 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { ...PORTAL, authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const issues = [];
const step = async (name, fn) => { try { await fn(); console.log(`✓ ${name}`); } catch (e) { issues.push(name); console.log(`✗ ${name}\n    ${String(e?.message ?? e).slice(0, 600)}`); } };
const expect = (c, m) => { if (!c) throw new Error(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 600)); };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const db = mongoose.connection.db;
const stamp = Date.now().toString(36);
const login = async (email) => (await call('POST', '/auth/login', { body: { email, password: 'Password123!' } })).body.data;
const admin = await login('qa@example.com');
for (const n of ['member', 'outsider']) await call('POST', '/auth/register', { body: { email: `${n}-${stamp}@example.com`, password: 'Password123!', name: n } });
const member = await login(`member-${stamp}@example.com`);
const outsider = await login(`outsider-${stamp}@example.com`);
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const ws = (await db.collection('workspacemembers').find({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId;
const mu = await db.collection('users').findOne({ email: `member-${stamp}@example.com` });
await db.collection('workspacemembers').updateOne({ userId: mu._id, workspaceId: ws }, { $setOnInsert: { userId: mu._id, workspaceId: ws, role: 'MEMBER', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
await db.collection('workspacemembers').deleteMany({ userId: mu._id, workspaceId: { $ne: ws } });
const q = `?workspaceId=${ws}`;

await step('a member can open the timeline (it used to answer 403 "Only workspace owners and admins")', async () => {
  const r = await call('GET', `/agents/timeline${q}`, { token: member.token });
  expect(r.status === 200 && Array.isArray(r.body.data?.items ?? r.body.data), r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  const a = await call('GET', `/agents/timeline/agents${q}`, { token: member.token });
  expect(a.status === 200, a.status);
});
await step('without ?workspaceId a member still gets their workspace', async () => {
  expect((await call('GET', '/agents/timeline', { token: member.token })).status === 200);
});
await step('a member does not see workspace-level alerts or other people\'s detections', async () => {
  await db.collection('agentalerts').insertOne({ workspaceId: ws, type: 'shadow_ai_prohibited', severity: 'critical', title: 'QA secret alert', detail: 'x', dedupeKey: 'qa-timeline-' + stamp, createdAt: new Date() });
  const m = await call('GET', `/agents/timeline${q}&kinds=detection`, { token: member.token });
  const a = await call('GET', `/agents/timeline${q}&kinds=detection`, { token: admin.token });
  const text = (r) => JSON.stringify(r.body);
  expect(!text(m).includes('QA secret alert'), 'member must not see a workspace-level alert');
  expect(text(a).includes('QA secret alert'), 'admin does see it');
  await db.collection('agentalerts').deleteMany({ dedupeKey: 'qa-timeline-' + stamp });
});
await step('a person outside the workspace cannot read it', async () => {
  const r = await call('GET', `/agents/timeline${q}`, { token: outsider.token });
  expect(r.status === 403, r.status);
});
await step('a bad workspace id is a 400, not a crash', async () => {
  expect((await call('GET', '/agents/timeline?workspaceId=nope', { token: member.token })).status === 400);
});
await step('the admin timeline still works', async () => {
  expect((await call('GET', `/agents/timeline${q}`, { token: admin.token })).status === 200);
});
await step('shadow AI catalog tells the portal who is an admin', async () => {
  expect((await call('GET', `/shadow-ai/catalog${q}`, { token: member.token })).body.data.isAdmin === false);
  expect((await call('GET', `/shadow-ai/catalog${q}`, { token: admin.token })).body.data.isAdmin === true);
});
console.log(issues.length ? `\n${issues.length} failed: ${issues.join('; ')}` : '\nAll member timeline checks passed');
await mongoose.disconnect();
process.exit(issues.length ? 1 : 0);
