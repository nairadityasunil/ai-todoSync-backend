// Inviting someone with no account: the link lets them sign up and joins them to the project and its workspace.
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const r = await fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
await call(null, 'POST', '/auth/register', { email: `owner-${s}@example.com`, password: 'Password123!', name: 'Owner' });
const admin = (await call(null, 'POST', '/auth/login', { email: `owner-${s}@example.com`, password: 'Password123!' })).j.data.token;
const P = (await call(admin, 'POST', '/projects', { name: 'Onboard ' + s })).j.data.project;
const proj = await db.collection('projects').findOne({ _id: new mongoose.Types.ObjectId(P.id) });
const invite = async (email, role) => { const r = await call(admin, 'POST', `/invitations/projects/${P.id}`, { email, role }); const inv = await db.collection('invitations').findOne({ email, projectId: new mongoose.Types.ObjectId(P.id) }); return { r, inv }; };

const e1 = `fresh-${s}@example.com`; let { r, inv } = await invite(e1, 'MEMBER');
ok(r.status === 201 && inv?.status === 'PENDING', 'inviting an unknown email creates a pending invitation');
r = await call(null, 'GET', `/invitations/verify?token=${inv.token}`);
ok(r.status === 200 && r.j.data.isRegistered === false && !!r.j.data.inviterName && r.j.data.projectName === 'Onboard ' + s, 'the link shows the project, who invited, and that no account exists');

// Sign up through the link. The email in the request is ignored; the invitation's email is used.
r = await call(null, 'POST', '/auth/register', { inviteToken: inv.token, email: `attacker-${s}@example.com`, password: 'Password123!', firstName: 'Fran', lastName: 'Fresh' });
ok(r.status === 201 && r.j.data.user.email === e1, 'the account is created for the invited email, not the one in the request');
ok(r.j.data.joined?.projectId === P.id && String(r.j.data.joined?.workspaceId) === String(proj.workspaceId), 'sign-up returns the project and workspace joined');
const u = await db.collection('users').findOne({ email: e1 });
ok(!(await db.collection('users').findOne({ email: `attacker-${s}@example.com` })), 'no account was created for the other email');
const pm = await db.collection('projectmembers').findOne({ userId: u._id, projectId: proj._id });
const wm = await db.collection('workspacemembers').findOne({ userId: u._id, workspaceId: proj.workspaceId });
ok(pm?.role === 'MEMBER', 'they are a project member with the invited role');
ok(wm?.role === 'MEMBER', 'they are in the inviter workspace');
ok((await db.collection('invitations').findOne({ _id: inv._id })).status === 'ACCEPTED', 'the invitation is marked accepted');
const tok = r.j.data.token;
const list = (await call(tok, 'GET', '/projects?limit=50')).j.data.projects;
ok(list.some((p) => p.id === P.id && p.currentUserRole === 'MEMBER'), 'the new person is signed in and sees the project');
r = await call(null, 'POST', '/auth/register', { inviteToken: inv.token, password: 'Password123!', firstName: 'X', lastName: 'Y' }); ok(r.status === 400, 'a used link cannot be used again (' + r.status + ')');

// Admin role is honoured
const e2 = `boss-${s}@example.com`; ({ inv } = await invite(e2, 'ADMIN'));
r = await call(null, 'POST', '/auth/register', { inviteToken: inv.token, password: 'Password123!', firstName: 'B', lastName: 'Oss' });
ok(r.status === 201 && r.j.data.joined?.role === 'ADMIN', 'an invited admin joins as project admin');

// Expiry
const e3 = `late-${s}@example.com`; ({ inv } = await invite(e3, 'MEMBER'));
await db.collection('invitations').updateOne({ _id: inv._id }, { $set: { updatedAt: new Date(Date.now() - 20 * 86400000) } });
r = await call(null, 'GET', `/invitations/verify?token=${inv.token}`); ok(r.status === 410, 'an old invitation shows as expired (' + r.status + ')');
r = await call(null, 'POST', '/auth/register', { inviteToken: inv.token, password: 'Password123!', firstName: 'L', lastName: 'Ate' }); ok(r.status === 410 && !(await db.collection('users').findOne({ email: e3 })), 'an expired invitation cannot create an account');
({ inv } = await invite(e3, 'MEMBER')); r = await call(null, 'GET', `/invitations/verify?token=${inv.token}`); ok(r.status === 200, 're-inviting renews the link');

// Weak password and bad token
const e4 = `weak-${s}@example.com`; ({ inv } = await invite(e4, 'MEMBER'));
r = await call(null, 'POST', '/auth/register', { inviteToken: inv.token, password: 'short', firstName: 'W', lastName: 'Eak' });
ok(r.status === 400 && !(await db.collection('users').findOne({ email: e4 })) && (await db.collection('invitations').findOne({ _id: inv._id })).status === 'PENDING', 'a weak password is rejected and the invitation stays usable');
ok((await call(null, 'POST', '/auth/register', { inviteToken: 'nope', password: 'Password123!', firstName: 'N', lastName: 'O' })).status === 404, 'an unknown link is 404');

// Someone who already has an account is told to log in
const e5 = `have-${s}@example.com`; await call(null, 'POST', '/auth/register', { email: e5, password: 'Password123!', name: 'Have' });
({ inv } = await invite(e5, 'MEMBER'));
r = await call(null, 'POST', '/auth/register', { inviteToken: inv.token, password: 'Password123!', firstName: 'H', lastName: 'Ave' });
ok(r.status === 409 && /log in/i.test(r.j.error ?? ''), 'an existing account is told to log in instead');
const haveTok = (await call(null, 'POST', '/auth/login', { email: e5, password: 'Password123!' })).j.data.token;
r = await call(haveTok, 'POST', '/invitations/accept', { token: inv.token });
ok(r.status === 200 && String(r.j.data.workspaceId) === String(proj.workspaceId) && r.j.data.projectId === P.id, 'accepting while logged in returns the project and workspace to open');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
