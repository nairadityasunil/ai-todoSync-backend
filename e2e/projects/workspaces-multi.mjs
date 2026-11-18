// Several workspaces per person, a "recent first" order, and project members becoming workspace members.
import mongoose from 'mongoose';
import { execFileSync } from 'child_process';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
const A = await reg('wm-a'), B = await reg('wm-b');
const list = async (tok) => (await call(tok, 'GET', '/workspaces')).j.workspaces;

// More than one workspace
const created = [];
for (const name of ['Second ' + s, 'Third ' + s, 'Fourth ' + s]) {
  const r = await call(A.token, 'POST', '/workspaces', { name });
  ok(r.status === 201 || r.status === 200, `a person can create another workspace (${name})`);
  created.push(r.j.workspace ?? r.j.data);
}
let mine = await list(A.token);
ok(mine.length >= 4 && created.every((w) => mine.some((m) => m.id === (w.id ?? w._id))), `all of them are listed (${mine.length} workspaces)`);
ok(created.every((w) => mine.find((m) => m.id === (w.id ?? w._id))?.role === 'OWNER'), 'and the creator owns each one');

// Recent first
const ids = created.map((w) => w.id ?? w._id);
const defaultId = mine.find((m) => !ids.includes(m.id)).id;
for (const id of [defaultId, ids[0], ids[1]]) { await call(A.token, 'POST', `/workspaces/${id}/use`); await new Promise((r) => setTimeout(r, 30)); }
mine = await list(A.token);
ok(mine[0].id === ids[1] && mine[1].id === ids[0] && mine[2].id === defaultId, 'the list puts the most recently opened workspaces first');
ok(mine.every((m) => 'lastUsedAt' in m), 'every row says when it was last opened');
ok([403, 404].includes((await call(B.token, 'POST', `/workspaces/${ids[0]}/use`)).status), "someone else's workspace cannot be marked as used");

// A project member becomes a workspace member (MEMBER)
const proj = (await call(A.token, 'POST', '/projects', { name: 'WM project ' + s, workspaceId: ids[2] })).j.data.project;
ok(String((await db.collection('projects').findOne({ _id: new mongoose.Types.ObjectId(proj.id) })).workspaceId) === ids[2], 'the project is in the fourth workspace');
ok(!(await list(B.token)).some((m) => m.id === ids[2]), 'B is not in that workspace yet');
await call(A.token, 'POST', `/invitations/projects/${proj.id}`, { email: `wm-b-${s}@example.com` });
const inv = await db.collection('invitations').findOne({ projectId: new mongoose.Types.ObjectId(proj.id), email: `wm-b-${s}@example.com` });
const acc = await call(B.token, 'POST', '/invitations/accept', { token: inv.token });
ok(acc.status === 200, 'B accepts the project invitation');
const bws = (await list(B.token)).find((m) => m.id === ids[2]);
ok(bws && bws.role === 'MEMBER', 'B is now a MEMBER of the workspace the project is in');

// Repair for people who joined a project before this rule
const bId = (await db.collection('users').findOne({ email: `wm-b-${s}@example.com` }))._id;
await db.collection('workspacemembers').deleteOne({ workspaceId: new mongoose.Types.ObjectId(ids[2]), userId: bId });
ok(!(await list(B.token)).some((m) => m.id === ids[2]), 'removing the workspace membership by hand (an old project member)');
execFileSync('npx', ['tsx', '-e', "import('./src/modules/workspace/services/workspace-membership-repair.service.ts').then(async (m) => { const mongoose = (await import('mongoose')).default; await mongoose.connect('mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); console.log('added', await m.addMissingWorkspaceMembers()); await mongoose.disconnect(); })"], { stdio: 'inherit', env: process.env });
ok((await list(B.token)).find((m) => m.id === ids[2])?.role === 'MEMBER', 'the repair adds them back as a MEMBER');
// someone with a higher role keeps it
await db.collection('workspacemembers').updateOne({ workspaceId: new mongoose.Types.ObjectId(ids[2]), userId: bId }, { $set: { role: 'ADMIN' } });
execFileSync('npx', ['tsx', '-e', "import('./src/modules/workspace/services/workspace-membership-repair.service.ts').then(async (m) => { const mongoose = (await import('mongoose')).default; await mongoose.connect('mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); await m.addMissingWorkspaceMembers(); await mongoose.disconnect(); })"], { stdio: 'ignore', env: process.env });
ok((await list(B.token)).find((m) => m.id === ids[2])?.role === 'ADMIN', 'a higher role is never lowered');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
