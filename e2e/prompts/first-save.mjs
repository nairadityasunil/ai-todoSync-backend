// The first save of a new prompt is version 1; later saves are 2, 3...; a used placeholder is not replaced.
import mongoose from 'mongoose';
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const PORTAL = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0', origin: process.env.APP_URL ?? 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { ...PORTAL, authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const issues = [];
const step = async (name, fn) => { try { await fn(); console.log(`✓ ${name}`); } catch (e) { issues.push(name); console.log(`✗ ${name}\n    ${String(e?.message ?? e).slice(0, 500)}`); } };
const expect = (c, m) => { if (!c) throw new Error(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 500)); };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const db = mongoose.connection.db;
const login = (await call('POST', '/auth/login', { body: { email: 'qa@example.com', password: 'Password123!' } })).body.data;
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const ws = String((await db.collection('workspacemembers').find({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId);
const P = `/workspaces/${ws}/prompts`;
const stamp = Date.now().toString(36);
const versions = async (id) => (await db.collection('promptversions').find({ promptId: new mongoose.Types.ObjectId(id) }).sort({ version: 1 }).toArray());
// A blank starting point, as the playground's New prompt button makes it.
const create = async (name) => (await call('POST', P, { token: login.token, body: { name, body: 'Write a short answer.', draft: true } })).body.data;
// A prompt made with content (API, library): its content is version 1 and the next edit is version 2.
const createWithContent = async (name) => (await call('POST', P, { token: login.token, body: { name, body: 'Write a short answer.' } })).body.data;

await step('a prompt made with content keeps it as version 1 and the next edit is version 2', async () => {
  const p = await createWithContent('With content ' + stamp);
  const r = await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'A different answer.' } });
  expect(r.status === 200 && r.body.data.version === 2, r.body.data?.version);
  const v = await versions(p._id);
  expect(v.length === 2 && v[0].body === 'Write a short answer.', v.map((x) => x.version));
});

await step('a new prompt starts with one placeholder version 1', async () => {
  const p = await create('First save ' + stamp);
  expect(p.version === 1, p.version);
  expect((await versions(p._id)).length === 1);
});
await step('the first save with real content stays version 1 (it used to become version 2)', async () => {
  const p = await create('First save B ' + stamp);
  const r = await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'Summarise {{topic}} for a manager.' } });
  expect(r.status === 200, r.body);
  const saved = r.body.data;
  expect(saved.version === 1 && saved.body.includes('{{topic}}'), `version ${saved.version}`);
  const v = await versions(p._id);
  expect(v.length === 1 && v[0].version === 1 && v[0].body.includes('{{topic}}'), v.map((x) => x.version));
  expect(saved.variables?.some((x) => x.name === 'topic'), 'the {{topic}} variable is declared');
});
await step('the second save is version 2, the third version 3', async () => {
  const p = await create('First save C ' + stamp);
  await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'One.' } });
  const two = (await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'Two.' } })).body.data;
  const three = (await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'Three.' } })).body.data;
  expect(two.version === 2 && three.version === 3, `${two.version}, ${three.version}`);
  expect((await versions(p._id)).map((x) => x.version).join() === '1,2,3');
});
await step('saving the same content again does not make a new version', async () => {
  const p = await create('First save D ' + stamp);
  await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'Same.' } });
  const again = (await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'Same.' } })).body.data;
  expect(again.version === 1 && (await versions(p._id)).length === 1, again.version);
});
await step('a placeholder that was deployed or run is kept: the next save is version 2', async () => {
  const p = await create('First save E ' + stamp);
  await db.collection('promptdeploymentevents').insertOne({ promptId: new mongoose.Types.ObjectId(p._id), action: 'production_deployed', createdAt: new Date() });
  const r = (await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { body: 'After deploy.' } })).body.data;
  expect(r.version === 2, `version ${r.version}`);
  await db.collection('promptdeploymentevents').deleteMany({ promptId: new mongoose.Types.ObjectId(p._id) });
});
await step('renaming alone does not make a version', async () => {
  const p = await create('First save F ' + stamp);
  const r = (await call('PATCH', `${P}/${p._id}`, { token: login.token, body: { name: 'Renamed ' + stamp } })).body.data;
  expect(r.name === 'Renamed ' + stamp && r.version === 1 && (await versions(p._id)).length === 1, r);
});
console.log(issues.length ? `\n${issues.length} failed: ${issues.join('; ')}` : '\nAll first-save checks passed');
await mongoose.disconnect(); process.exit(issues.length ? 1 : 0);
