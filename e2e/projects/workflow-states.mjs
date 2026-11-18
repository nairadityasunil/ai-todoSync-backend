// Project workflow states drive task status: a task's state and its built-in status stay in step.
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const r = await fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
await call(null, 'POST', '/auth/register', { email: `wf-${s}@example.com`, password: 'Password123!', name: 'WF' });
const tok = (await call(null, 'POST', '/auth/login', { email: `wf-${s}@example.com`, password: 'Password123!' })).j.data.token;
const P = (await call(tok, 'POST', '/projects', { name: 'Flow ' + s })).j.data.project;
const Q = (await call(tok, 'POST', '/projects', { name: 'Other ' + s })).j.data.project;
const day = '2026-11-18';
const mk = async (pid, body = {}) => (await call(tok, 'POST', '/tasks', { title: 'T ' + Math.random().toString(36).slice(2, 6), date: day, projectId: pid, ...body })).j.data.task;
const get = async (pid, id) => (await call(tok, 'GET', `/tasks?projectId=${pid}&date=${day}`)).j.data.tasks.find((t) => t.id === id);

// A project with no states: tasks work as before
let t = await mk(Q.id); ok(t.stateId === null && t.status === 'TODO', 'no states: a task has no state and the usual status');
ok((await call(tok, 'PATCH', `/tasks/${t.id}`, { status: 'IN_REVIEW' })).j.data.task.status === 'IN_REVIEW', 'no states: the built-in statuses still work');

// Define a workflow
const defs = [['Backlog', 'BACKLOG'], ['Todo', 'UNSTARTED'], ['In Progress', 'STARTED'], ['Review', 'STARTED'], ['Done', 'COMPLETED'], ['Dropped', 'CANCELED']];
const states = {};
for (const [name, category] of defs) { const r = await call(tok, 'POST', `/projects/${P.id}/states`, { name, category, color: '#3B82F6' }); states[name] = r.j.state?._id; }
ok(Object.values(states).every(Boolean), 'six workflow states created');

t = await mk(P.id);
ok(t.stateId === states['Todo'] && t.status === 'TODO', 'a new task starts in the first "not started" state');
ok((await mk(P.id, { stateId: states['In Progress'] })).status === 'IN_PROGRESS', 'creating a task in a state sets its status');
let r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: states['Review'] });
ok(r.status === 200 && r.j.data.task.stateId === states['Review'] && r.j.data.task.status === 'IN_PROGRESS', 'moving to Review (a started state) makes the status In Progress');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: states['Done'] }); ok(r.j.data.task.status === 'DONE' && r.j.data.task.stateId === states['Done'], 'moving to Done (completed) completes the task');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: states['Backlog'] }); ok(r.j.data.task.status === 'BACKLOG', 'moving to Backlog sets Backlog');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: states['Dropped'] }); ok(r.j.data.task.status === 'DONE', 'a canceled state closes the task');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { status: 'IN_PROGRESS' }); ok(r.j.data.task.stateId === states['In Progress'], 'changing the built-in status picks the matching state (older clients keep working)');
r = await call(tok, 'PATCH', `/tasks/${t.id}/status`, { status: 'DONE' }); ok(r.status === 200 && r.j.data.task.stateId === states['Done'], 'the status endpoint keeps the state in step too');

// Validation
const otherState = (await call(tok, 'POST', `/projects/${Q.id}/states`, { name: 'Elsewhere', category: 'STARTED', color: '#10B981' })).j.state?._id;
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: otherState }); ok(r.status === 400, 'a state from another project is refused (' + r.status + ')');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: '000000000000000000000000' }); ok(r.status === 400, 'an unknown state is refused');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: null }); ok(r.status === 200 && r.j.data.task.stateId === null, 'a state can be cleared');

// Move between projects
const m = await mk(P.id, { stateId: states['Review'] });
r = await call(tok, 'PATCH', `/tasks/${m.id}`, { projectId: Q.id }); ok(r.j.data.task.stateId === otherState, "moving to another project drops the old project's state and picks that project's matching one");
r = await call(tok, 'PATCH', `/tasks/${m.id}`, { projectId: P.id }); ok(r.j.data.task.stateId === states['In Progress'], 'moving back picks the state that matches the status');
const plain = (await call(tok, 'POST', '/projects', { name: 'Plain ' + s })).j.data.project; r = await call(tok, 'PATCH', `/tasks/${m.id}`, { projectId: plain.id }); ok(r.j.data.task.stateId === null, 'moving to a project with no states clears the state');

// Blocked tasks cannot be completed through a state either
const b = await mk(P.id); await call(tok, 'PATCH', `/tasks/${b.id}/block`, {});
r = await call(tok, 'PATCH', `/tasks/${b.id}`, { stateId: states['Done'] }); ok(r.status === 400, 'a blocked task cannot be moved to a completed state');

// Existing tasks without a state keep working
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const old = await mk(P.id); await mongoose.connection.db.collection('tasks').updateOne({ _id: new mongoose.Types.ObjectId(old.id) }, { $unset: { stateId: '' } });
ok((await get(P.id, old.id)).stateId === null, 'a task from before states reads as having no state');
r = await call(tok, 'PATCH', `/tasks/${old.id}`, { title: 'Renamed only' }); ok(r.status === 200 && r.j.data.task.status === 'TODO', 'and can still be edited');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
