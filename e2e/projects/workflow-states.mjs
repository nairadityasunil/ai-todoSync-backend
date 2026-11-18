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
// New projects start with the default workflow (checked below). To test other workflows, clear the defaults first.
const clearStates = async (pid) => { for (const st of (await call(tok, 'GET', `/projects/${pid}/states`)).j.states) await call(tok, 'DELETE', `/projects/${pid}/states/${st._id}`); };
const defaults = (await call(tok, 'GET', `/projects/${P.id}/states`)).j.states;
ok(defaults.map((x) => x.name).join(',') === 'Backlog,In Progress,Review,Done' && defaults.map((x) => x.category).join(',') === 'BACKLOG,STARTED,STARTED,COMPLETED', 'a new project starts with four states: Backlog, In Progress, Review, Done');
const first = await (async () => (await call(tok, 'POST', '/tasks', { title: 'First', date: '2026-11-18', projectId: P.id })).j.data.task)();
ok(first.stateId === defaults[0]._id, 'the first task goes to the first state (Backlog) and the board and dropdown show only these four');
await clearStates(P.id); await clearStates(Q.id);
ok((await call(tok, 'GET', `/projects/${P.id}/states`)).j.states.length === 0, 'deleting every state on purpose leaves the project with none (the defaults are not added again)');
// A project made before states existed gets the defaults once, and its tasks are placed by status
const legacy = (await call(tok, 'POST', '/projects', { name: 'Legacy ' + s })).j.data.project;
await clearStates(legacy.id);
const lt = (await call(tok, 'POST', '/tasks', { title: 'Old todo', date: '2026-11-18', projectId: legacy.id })).j.data.task;
const ld = (await call(tok, 'POST', '/tasks', { title: 'Old done', date: '2026-11-18', projectId: legacy.id, status: 'DONE' })).j.data.task;
const mg = (await import('mongoose')).default; await mg.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
await mg.connection.db.collection('projects').updateOne({ _id: new mg.Types.ObjectId(legacy.id) }, { $set: { states: [], statesInitialized: false } });
await mg.connection.db.collection('tasks').updateMany({ projectId: new mg.Types.ObjectId(legacy.id) }, { $unset: { stateId: '' } });
let ls = (await call(tok, 'GET', `/projects/${legacy.id}/states`)).j.states;
ok(ls.map((x) => x.name).join(',') === 'Backlog,In Progress,Review,Done', 'an older project gets the same four states when they are first read');
const back = (await call(tok, 'GET', `/tasks?projectId=${legacy.id}&date=2026-11-18`)).j.data.tasks;
ok(back.find((t) => t.id === lt.id).stateId === ls[0]._id && back.find((t) => t.id === ld.id).stateId === ls[3]._id, 'and its tasks are placed by status (to do in Backlog, done in Done)');
ls = (await call(tok, 'GET', `/projects/${legacy.id}/states`)).j.states; ok(ls.length === 4, 'reading again does not add them twice');
await mg.disconnect();
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

// A workflow with no state of a task's kind: the task still lands in a column
const odd = (await call(tok, 'POST', '/projects', { name: 'Odd ' + s })).j.data.project;
await clearStates(odd.id);
const oddStates = {};
for (const [name, category] of [['Open', 'STARTED'], ['Shipped', 'COMPLETED']]) oddStates[name] = (await call(tok, 'POST', `/projects/${odd.id}/states`, { name, category, color: '#3B82F6' })).j.state?._id;
let ot = await mk(odd.id); ok(ot.status === 'TODO' && ot.stateId === oddStates['Open'], 'no "not started" state: a new task goes to the first column');
r = await call(tok, 'PATCH', `/tasks/${ot.id}`, { status: 'DONE' }); ok(r.j.data.task.stateId === oddStates['Shipped'], 'and finished work to the completed column');
r = await call(tok, 'PATCH', `/tasks/${ot.id}`, { status: 'BACKLOG' }); ok(r.j.data.task.stateId === oddStates['Open'], 'a backlog task with no backlog state also goes to the first column');

// Validation
const otherState = (await call(tok, 'POST', `/projects/${Q.id}/states`, { name: 'Elsewhere', category: 'STARTED', color: '#10B981' })).j.state?._id;
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: otherState }); ok(r.status === 400, 'a state from another project is refused (' + r.status + ')');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: '000000000000000000000000' }); ok(r.status === 400, 'an unknown state is refused');
r = await call(tok, 'PATCH', `/tasks/${t.id}`, { stateId: null }); ok(r.status === 200 && r.j.data.task.stateId === null, 'a state can be cleared');

// Move between projects
const m = await mk(P.id, { stateId: states['Review'] });
r = await call(tok, 'PATCH', `/tasks/${m.id}`, { projectId: Q.id }); ok(r.j.data.task.stateId === otherState, "moving to another project drops the old project's state and picks that project's matching one");
r = await call(tok, 'PATCH', `/tasks/${m.id}`, { projectId: P.id }); ok(r.j.data.task.stateId === states['In Progress'], 'moving back picks the state that matches the status');
const plain = (await call(tok, 'POST', '/projects', { name: 'Plain ' + s })).j.data.project; await clearStates(plain.id); r = await call(tok, 'PATCH', `/tasks/${m.id}`, { projectId: plain.id }); ok(r.j.data.task.stateId === null, 'moving to a project with no states clears the state');

// Blocked tasks cannot be completed through a state either
const b = await mk(P.id); await call(tok, 'PATCH', `/tasks/${b.id}/block`, {});
r = await call(tok, 'PATCH', `/tasks/${b.id}`, { stateId: states['Done'] }); ok(r.status === 400, 'a blocked task cannot be moved to a completed state');

// Existing tasks without a state keep working
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' });
const old = await mk(P.id); await mongoose.connection.db.collection('tasks').updateOne({ _id: new mongoose.Types.ObjectId(old.id) }, { $unset: { stateId: '' } });
ok((await get(P.id, old.id)).stateId === null, 'a task from before states reads as having no state');
r = await call(tok, 'PATCH', `/tasks/${old.id}`, { title: 'Renamed only' }); ok(r.status === 200 && r.j.data.task.status === 'TODO', 'and can still be edited');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
