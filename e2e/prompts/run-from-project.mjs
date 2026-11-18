// Prompts a person can run from a project: the deployed ones, with variables and canary info; run the deployed version.
// Start the backend with `--import e2e/prompts/llm-stub.mjs` so provider calls are answered without a real key.
import mongoose from 'mongoose';
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const P = { 'user-agent': 'Mozilla/5.0 Chrome/130', origin: process.env.APP_URL ?? 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site', 'content-type': 'application/json' };
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { ...P, ...(t ? { authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
const bad = []; const ok = (n, c, x) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) { bad.push(n); if (x !== undefined) console.log('   ', JSON.stringify(x).slice(0, 400)); } };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const db = mongoose.connection.db;
const stamp = Date.now().toString(36);
const t = (await call('POST', '/auth/login', null, { email: 'qa@example.com', password: 'Password123!' })).b.data.token;
const me = await db.collection('users').findOne({ email: 'qa@example.com' });
const wid = String((await call('GET', '/workspaces', t)).b.workspaces[0].id);
const W = `/workspaces/${wid}/prompts`;
const proj = (await call('POST', '/projects', t, { name: 'Run test ' + stamp })).b.data.project;
const mk = async (name, body, vars) => (await call('POST', W, t, { name, body, variables: vars })).b.data;
const dep = await mk('Deployed ' + stamp, 'Plan {{topic}} for {{count}} people. Be brief.', [{ name: 'topic', type: 'string', required: true }, { name: 'count', type: 'number', required: false, defaultValue: '3' }]);
await call('PATCH', `${W}/${dep._id}`, t, { body: 'Plan {{topic}} for {{count}} people. Be brief.', variables: [{ name: 'topic', type: 'string', required: true }, { name: 'count', type: 'number', required: false, defaultValue: '3' }] });
const draft = await mk('Draft only ' + stamp, 'Never deployed {{x}}', [{ name: 'x', type: 'string', required: false }]);
await call('POST', `${W}/${dep._id}/deploy/direct`, t, { versionNumber: 1 });
await db.collection('users').updateOne({ _id: me._id }, { $set: { geminiApiKey: 'test-key' } });

const list = async (q = '') => (await call('GET', `${W}/runnable?projectId=${proj.id}${q}`, t));
ok('only deployed prompts are listed by default', (await list()).b.data.some((p) => p.name === 'Deployed ' + stamp) && !(await list()).b.data.some((p) => p.name === 'Draft only ' + stamp));
ok('undeployed ones appear when asked', (await list('&includeUndeployed=true')).b.data.some((p) => p.name === 'Draft only ' + stamp));
const row = (await list()).b.data.find((p) => p.name === 'Deployed ' + stamp);
ok('the row carries the production version, variables with defaults, and no canary', row.productionVersion === 1 && row.variables.length === 2 && row.variables.find((v) => v.name === 'count').defaultValue === '3' && row.variables.find((v) => v.name === 'topic').required === true && row.canary === null, row);
ok('search narrows the list', (await list('&search=nomatchxyz')).b.data.length === 0);
const other = (await call('POST', '/auth/register', null, { email: `norun-${stamp}@example.com`, password: 'Password123!', name: 'x' }), (await call('POST', '/auth/login', null, { email: `norun-${stamp}@example.com`, password: 'Password123!' })).b.data.token);
ok('a person outside the project cannot list for it', (await call('GET', `${W}/runnable?projectId=${proj.id}`, other)).s === 403 || (await call('GET', `${W}/runnable?projectId=${proj.id}`, other)).s === 404);

const run = (body, token = t) => call('POST', `${W}/${row.id}/playground/run`, token, { environment: 'production', projectId: proj.id, ...body });
let r = await run({ variables: { topic: 'the launch' } });
ok('running the deployed version fills the variables (count default 3) and returns the output with version info', r.s === 200 && /the launch/.test(r.b.data.output) && /3/.test(r.b.data.output) && r.b.data.metadata.versionNumber === 1 && r.b.data.metadata.environment === 'production' && r.b.data.metadata.isCanary === false, r.b);
ok('a missing required variable is refused with its name', (await run({ variables: {} })).s === 400);
ok('a wrong type is refused', (await run({ variables: { topic: 'x', count: 'many' } })).s === 400);
ok('the run is recorded as project AI for that project', !!(await db.collection('promptexecutionlogs').findOne({ projectId: new mongoose.Types.ObjectId(proj.id), source: 'project_ai' })));
ok('a person outside the project cannot run for it', [403, 404].includes((await run({ variables: { topic: 'x' } }, other)).s));
await db.collection('users').updateOne({ _id: me._id }, { $unset: { geminiApiKey: '' } });
const nokey = await run({ variables: { topic: 'x' } });
ok('without a saved key the message says where to add it', nokey.s === 400 && /Settings/.test(JSON.stringify(nokey.b)), nokey);
console.log(bad.length ? `\n${bad.length} failed` : '\nAll checks passed'); await mongoose.disconnect(); process.exit(bad.length ? 1 : 0);
