// Task assignment email, and project invites that bring the person into the workspace and the project.
import mongoose from 'mongoose';
import fs from 'node:fs';
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const LOG = process.env.BACKEND_LOG ?? '/tmp/claude-0/backend.log';
const P = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', origin: process.env.APP_URL ?? 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const call = async (method, path, { token, body } = {}) => { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { ...P, authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
const issues = [];
const step = async (n, f) => { try { await f(); console.log(`✓ ${n}`); } catch (e) { issues.push(n); console.log(`✗ ${n}\n    ${String(e?.message ?? e).slice(0, 500)}`); } };
const expect = (c, m) => { if (!c) throw new Error(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 500)); };
const mails = (to) => fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('[MOCK EMAIL]') && l.includes(`To: ${to}`));
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const db = mongoose.connection.db;
const stamp = Date.now().toString(36);
const reg = async (n) => { await call('POST', '/auth/register', { body: { email: `${n}-${stamp}@example.com`, password: 'Password123!', name: n } }); return (await call('POST', '/auth/login', { body: { email: `${n}-${stamp}@example.com`, password: 'Password123!' } })).body.data; };
const admin = (await call('POST', '/auth/login', { body: { email: 'qa@example.com', password: 'Password123!' } })).body.data;
const bob = await reg('bob'); const eve = await reg('eve');
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const ws = (await db.collection('workspacemembers').find({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId;
const user = async (n) => db.collection('users').findOne({ email: `${n}-${stamp}@example.com` });
const bobU = await user('bob'), eveU = await user('eve');
await db.collection('workspacemembers').updateOne({ userId: bobU._id, workspaceId: ws }, { $setOnInsert: { userId: bobU._id, workspaceId: ws, role: 'MEMBER', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
const proj = (await call('POST', '/projects', { token: admin.token, body: { name: 'Team test ' + stamp, workspaceId: String(ws) } })).body.data.project;
let taskId;
await step('a workspace member can be added to the project directly', async () => {
  expect((await call('POST', `/projects/${proj.id}/members`, { token: admin.token, body: { userId: String(bobU._id) } })).status === 201);
});
await step('someone outside the workspace cannot be added directly (they must be invited)', async () => {
  const r = await call('POST', `/projects/${proj.id}/members`, { token: admin.token, body: { userId: String(eveU._id) } });
  expect(r.status === 400 && /Invite them by email/.test(JSON.stringify(r.body)), r);
});
await step('assigning a task to a member emails that member (not the assigner)', async () => {
  const before = mails(bobU.email).length;
  const t = await call('POST', '/tasks', { token: admin.token, body: { title: 'Mail me ' + stamp, projectId: proj.id, date: new Date().toISOString().slice(0, 10), assignedTo: String(bobU._id), priority: 'HIGH' } });
  expect(t.status === 201, t.body); taskId = t.body.data.task.id;
  await new Promise((r) => setTimeout(r, 1200));
  const m = mails(bobU.email);
  expect(m.length === before + 1 && /assigned you a task/.test(m.at(-1)) && /Mail me/.test(m.at(-1)), m.slice(-1));
  expect(mails(me.email).filter((l) => /Mail me/.test(l)).length === 0, 'the assigner must not get one');
});
await step('a task created for yourself sends no email', async () => {
  const before = mails(me.email).length;
  await call('POST', '/tasks', { token: admin.token, body: { title: 'Mine ' + stamp, projectId: proj.id, date: new Date().toISOString().slice(0, 10) } });
  await new Promise((r) => setTimeout(r, 800));
  expect(mails(me.email).length === before);
});
await step('a member who made a task can give it to another member, who is emailed', async () => {
  const mine = await call('POST', '/tasks', { token: bob.token, body: { title: 'Bob made this ' + stamp, projectId: proj.id, date: new Date().toISOString().slice(0, 10) } });
  expect(mine.status === 201, mine.body);
  const before = mails(me.email).length;
  const r = await call('PATCH', `/tasks/${mine.body.data.task.id}/assign`, { token: bob.token, body: { assignedTo: String(me._id), userId: String(me._id) } });
  expect(r.status === 200, r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  await new Promise((r2) => setTimeout(r2, 1200));
  const m = mails(me.email);
  expect(m.length === before + 1 && /assigned you a task/.test(m.at(-1)) && /Bob made this/.test(m.at(-1)), m.slice(-1));
});
await step('inviting a person outside the workspace sends an email with an accept link', async () => {
  const r = await call('POST', `/invitations/projects/${proj.id}`, { token: admin.token, body: { email: eveU.email, role: 'MEMBER' } });
  expect(r.status === 200 || r.status === 201, r.body);
  await new Promise((r2) => setTimeout(r2, 1500));
  expect(mails(eveU.email).some((l) => /accept-invitation\?token=/.test(l)), mails(eveU.email).slice(-1));
});
await step('accepting joins the project AND the workspace', async () => {
  const inv = await db.collection('invitations').findOne({ email: eveU.email, status: 'PENDING' });
  const r = await call('POST', '/invitations/accept', { token: eve.token, body: { token: inv.token } });
  expect(r.status === 200, r.body);
  expect(await db.collection('projectmembers').findOne({ userId: eveU._id, projectId: new mongoose.Types.ObjectId(proj.id) }), 'project member');
  expect(await db.collection('workspacemembers').findOne({ userId: eveU._id, workspaceId: ws }), 'workspace member');
});
console.log(issues.length ? `\n${issues.length} failed: ${issues.join('; ')}` : '\nAll team checks passed');
await mongoose.disconnect(); process.exit(issues.length ? 1 : 0);
