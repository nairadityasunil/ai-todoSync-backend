// A project admin can turn SLA tracking off and on for a project.
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
const A = await reg('st-a'), B = await reg('st-b');
const proj = (await call(A.token, 'POST', '/projects', { name: 'Toggle ' + s })).j.data.project;
await call(A.token, 'POST', `/invitations/projects/${proj.id}`, { email: `st-b-${s}@example.com` });
await call(B.token, 'POST', '/invitations/accept', { token: (await call(B.token, 'GET', '/invitations/me')).j.data[0].token });
const projectOf = async (tok) => (await call(tok, 'GET', '/projects')).j.data.projects.find((p) => p.id === proj.id);
const taskOf = async (id) => { const all = (await call(A.token, 'GET', '/tasks')).j.data; return (Array.isArray(all) ? all : all.tasks).find((t) => t.id === id); };

ok((await projectOf(A.token)).slaEnabled === true, 'SLA tracking is on by default');
const t1 = (await call(A.token, 'POST', '/tasks', { title: 'before ' + s, projectId: proj.id, priority: 'HIGH' })).j.data.task;
ok(t1.slaResolutionDueAt != null, 'a task made while it is on has due dates');
await db.collection('tasks').updateOne({ _id: new mongoose.Types.ObjectId(t1.id) }, { $set: { responseBreached: true, resolutionBreached: true } });
let an = (await call(A.token, 'GET', `/sla/analytics?projectId=${proj.id}`)).j.data.summary;
ok(an.totalBreached === 1, 'its breach is counted');

ok((await call(B.token, 'PATCH', `/sla/projects/${proj.id}/enabled`, { enabled: false })).status === 403, 'a member cannot turn it off');
ok((await call(A.token, 'PATCH', `/sla/projects/${proj.id}/enabled`, { enabled: 'no' })).status === 400, 'a non-boolean is refused');
let r = await call(A.token, 'PATCH', `/sla/projects/${proj.id}/enabled`, { enabled: false });
ok(r.status === 200 && r.j.data.enabled === false, 'the project admin turns it off');
ok((await projectOf(B.token)).slaEnabled === false, 'every member sees the project as off');
r = await call(A.token, 'GET', `/sla/projects/${proj.id}/config`);
ok(r.j.data.enabled === false && r.j.data.configs.length === 4, 'the SLA settings say it is off and still hold the times');

const t2 = (await call(A.token, 'POST', '/tasks', { title: 'while off ' + s, projectId: proj.id, priority: 'HIGH' })).j.data.task;
ok(t2.slaResponseDueAt == null && t2.slaResolutionDueAt == null, 'a task made while it is off has no due dates');
an = (await call(A.token, 'GET', `/sla/analytics?projectId=${proj.id}`)).j.data.summary;
ok(an.totalBreached === 0 && an.responseCompliancePercent === 100, 'the project reports nothing while off');
ok((await call(A.token, 'GET', '/sla/breached-tasks')).j.data.tasks.every((t) => t.id !== t1.id), "and its tasks are left out of the breached list");
const all = (await call(A.token, 'GET', '/sla/analytics')).j.data.summary;
ok(all.totalBreached === 0, 'and out of the totals for everything');
const keep = await db.collection('tasks').findOne({ _id: new mongoose.Types.ObjectId(t1.id) });
ok(keep.responseBreached === true && keep.resolutionBreached === true && keep.slaResolutionDueAt, "nothing was erased from the existing task (its due dates and breach history are kept)");
r = await call(A.token, 'PATCH', `/tasks/${t2.id}`, { priority: 'CRITICAL' });
ok(r.status === 200 && r.j.data.task.slaResolutionDueAt == null, 'changing a priority while off does not create due dates');

r = await call(A.token, 'PATCH', `/sla/projects/${proj.id}/enabled`, { enabled: true });
ok(r.status === 200 && r.j.data.enabled === true, 'turning it back on');
const t2b = await taskOf(t2.id);
ok(t2b.slaResolutionDueAt != null && t2b.slaResponseDueAt != null, 'the task made while it was off now has due dates');
an = (await call(A.token, 'GET', `/sla/analytics?projectId=${proj.id}`)).j.data.summary;
ok(an.totalBreached === 1, 'and the earlier breach counts again');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
