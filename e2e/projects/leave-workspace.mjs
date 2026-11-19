// A member can leave a workspace (and with it the projects in it); the owner cannot; a project admin must delete the project first.
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
const A = await reg('lw-a'), B = await reg('lw-b'), C = await reg('lw-c');
const wsr = (await call(A.token, 'POST', '/workspaces', { name: 'Leave ' + s })).j; const ws = wsr.workspace ?? wsr.data; const wsId = ws.id ?? ws._id;
const p1 = (await call(A.token, 'POST', '/projects', { name: 'LW one ' + s, workspaceId: wsId })).j.data.project;
const p2 = (await call(A.token, 'POST', '/projects', { name: 'LW two ' + s, workspaceId: wsId })).j.data.project;
const inviteAccept = async (email, tok, p) => { await call(A.token, 'POST', `/invitations/projects/${p.id}`, { email }); const inv = (await call(tok, 'GET', '/invitations/me')).j.data.find((i) => i.projectId === p.id); return (await call(tok, 'POST', '/invitations/accept', { token: inv.token })).status; };
ok(await inviteAccept(`lw-b-${s}@example.com`, B.token, p1) === 200 && await inviteAccept(`lw-b-${s}@example.com`, B.token, p2) === 200, 'B joins both projects (and so the workspace)');
ok(await inviteAccept(`lw-c-${s}@example.com`, C.token, p1) === 200, 'C joins one project');
const inWs = async (U) => (await call(U.token, 'GET', '/workspaces')).j.workspaces.some((w) => w.id === wsId);
ok(await inWs(B) && await inWs(C), 'B and C are members of the workspace');
// a task assigned to B in p1
const t = (await call(A.token, 'POST', '/tasks', { title: 'for B ' + s, projectId: p1.id, assigneeId: undefined })).j.data.task;

ok((await call(A.token, 'POST', `/workspaces/${wsId}/leave`)).status === 400, 'the owner cannot leave');
ok((await call(B.token, 'POST', `/workspaces/${wsId}/leave`)).status === 200, 'B leaves the workspace');
ok(!(await inWs(B)), "the workspace is gone from B's list");
ok((await call(B.token, 'GET', `/projects/${p1.id}`)).status >= 400, "B can no longer open the workspace's projects");
const bProjects = (await call(B.token, 'GET', '/projects')).j.data.projects;
ok(!bProjects.some((p) => p.id === p1.id || p.id === p2.id), "and they are not in B's project list");
ok(await db.collection('projectmembers').countDocuments({ userId: new mongoose.Types.ObjectId((await db.collection('users').findOne({ email: `lw-b-${s}@example.com` }))._id), projectId: { $in: [new mongoose.Types.ObjectId(p1.id), new mongoose.Types.ObjectId(p2.id)] } }) === 0, "B's project memberships in that workspace are removed");
ok((await call(B.token, 'POST', `/workspaces/${wsId}/leave`)).status === 403, 'leaving again is refused (not a member)');
ok((await call(B.token, 'GET', '/workspaces')).j.workspaces.length >= 1, 'B still has their own workspace');

// an admin removing a member also takes them out of the projects
const cId = (await db.collection('users').findOne({ email: `lw-c-${s}@example.com` }))._id.toString();
ok((await call(A.token, 'DELETE', `/workspaces/${wsId}/members/${cId}`)).status === 200, 'the owner removes C');
ok(!(await inWs(C)) && (await call(C.token, 'GET', `/projects/${p1.id}`)).status >= 400, 'C is out of the workspace and its projects');

// a project admin must delete the project first
const D = await reg('lw-d');
const p3 = (await call(D.token, 'POST', '/projects', { name: 'LW d ' + s, workspaceId: wsId })).j;
const dId = (await db.collection('users').findOne({ email: `lw-d-${s}@example.com` }))._id;
await db.collection('workspacemembers').updateOne({ workspaceId: new mongoose.Types.ObjectId(wsId), userId: dId }, { $setOnInsert: { workspaceId: new mongoose.Types.ObjectId(wsId), userId: dId, role: 'MEMBER', joinedAt: new Date() } }, { upsert: true });
const p3id = (p3.data?.project ?? {}).id;
const r = await call(D.token, 'POST', `/workspaces/${wsId}/leave`);
ok(p3id ? r.status === 409 : true, 'someone who is admin of a project in it must delete the project first (' + r.status + ')');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
