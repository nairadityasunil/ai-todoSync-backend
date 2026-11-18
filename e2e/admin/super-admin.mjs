// Platform admin panel API: access control, user management, safety rules, audit log, analytics.
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const r = await fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data.token; };
const login = async (email, password) => call(null, 'POST', '/auth/login', { email, password });
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
const adminTok = await reg('sadmin'), userTok = await reg('plain'), victimTok = await reg('victim');
await db.collection('users').updateOne({ email: `sadmin-${s}@example.com` }, { $set: { platformRole: 'super_admin' } });
const idOf = async (n) => String((await db.collection('users').findOne({ email: `${n}-${s}@example.com` }))._id);
const [adminId, plainId, victimId] = [await idOf('sadmin'), await idOf('plain'), await idOf('victim')];

// Access control
ok((await call(null, 'GET', '/admin/users')).status === 401, 'no sign-in: 401');
ok((await call(userTok, 'GET', '/admin/users')).status === 403, 'a normal user is refused: 403');
ok((await call(userTok, 'GET', '/admin/analytics')).status === 403, 'a normal user cannot read analytics');
ok((await call(userTok, 'POST', '/admin/users', { email: `x-${s}@example.com` })).status === 403, 'a normal user cannot create users');
ok((await call(adminTok, 'GET', '/auth/me')).j.data.user.isSuperAdmin === true && (await call(userTok, 'GET', '/auth/me')).j.data.user.isSuperAdmin === false, 'the profile says who is a super admin');

// List, search, filter, sort, page
let r = await call(adminTok, 'GET', `/admin/users?q=victim-${s}`);
ok(r.status === 200 && r.j.data.total === 1 && r.j.data.users[0].email === `victim-${s}@example.com`, 'search finds one user by email');
ok(!JSON.stringify(r.j).match(/password|syncApiKey|ApiKey"/i), 'the list carries no secrets');
r = await call(adminTok, 'GET', '/admin/users?limit=2&page=1&sort=createdAt&order=desc'); ok(r.j.data.users.length === 2 && r.j.data.totalPages >= 2 && r.j.data.page === 1, 'paging works');
r = await call(adminTok, 'GET', '/admin/users?role=super_admin'); ok(r.j.data.users.some((u) => u.id === adminId) && r.j.data.users.every((u) => u.isSuperAdmin), 'filter: super admins only');
r = await call(adminTok, 'GET', `/admin/users/${victimId}`);
ok(r.status === 200 && r.j.data.memberships.workspaces.length >= 1 && Array.isArray(r.j.data.sessions) && r.j.data.sessions[0].active === true && 'aiRuns' in r.j.data.stats, 'detail: workspaces, sessions and usage');
ok((await call(adminTok, 'GET', '/admin/users/nope')).status === 404, 'unknown id is 404');

// Create
r = await call(adminTok, 'POST', '/admin/users', { email: `made-${s}@example.com`, name: 'Made By Admin' });
ok(r.status === 201 && r.j.data.temporaryPassword?.length >= 12, 'creating a user returns a one-time temporary password');
ok((await login(`made-${s}@example.com`, r.j.data.temporaryPassword)).status === 200, 'the new person can sign in with it');
ok((await call(adminTok, 'POST', '/admin/users', { email: `made-${s}@example.com` })).status === 409, 'a duplicate email is refused');
ok((await call(adminTok, 'POST', '/admin/users', { email: 'not-an-email' })).status === 400, 'a bad email is refused');
const madeId = await idOf('made');

// Edit
r = await call(adminTok, 'PATCH', `/admin/users/${madeId}`, { name: 'Renamed Person' }); ok(r.status === 200 && r.j.data.name === 'Renamed Person', 'rename a user');
ok((await call(adminTok, 'PATCH', `/admin/users/${madeId}`, { email: `plain-${s}@example.com` })).status === 409, 'changing to an email in use is refused');

// Suspend and reactivate
ok((await call(victimTok, 'GET', '/projects')).status === 200, 'before: the victim token works');
r = await call(adminTok, 'POST', `/admin/users/${victimId}/suspend`, { reason: 'test' }); ok(r.status === 200 && r.j.data.status === 'suspended', 'suspend');
ok((await call(victimTok, 'GET', '/projects')).status === 401, 'a suspended person is signed out at once');
r = await login(`victim-${s}@example.com`, 'Password123!'); ok(r.status === 403 && /suspended/i.test(r.j.error ?? ''), 'and cannot sign in again (403)');
ok((await call(adminTok, 'POST', `/admin/users/${victimId}/reactivate`)).j.data.status === 'active', 'reactivate');
ok((await login(`victim-${s}@example.com`, 'Password123!')).status === 200, 'they can sign in again');

// Safety rules
ok((await call(adminTok, 'POST', `/admin/users/${adminId}/suspend`, {})).status === 409, 'you cannot suspend yourself');
ok((await call(adminTok, 'POST', `/admin/users/${adminId}/remove-super-admin`)).status === 404, 'there is no way to remove super admin access from the panel');
ok((await call(adminTok, 'DELETE', `/admin/users/${adminId}`, { confirmEmail: `sadmin-${s}@example.com` })).status === 409, 'you cannot delete yourself');
ok((await call(adminTok, 'POST', `/admin/users/${plainId}/make-super-admin`)).status === 404, 'nobody can be made a super admin from the panel');
r = await call(adminTok, 'POST', '/admin/users', { email: `created-${s}@example.com`, name: 'Created', superAdmin: true });
ok(r.status === 201 && r.j.data.user.isSuperAdmin === false, 'an account created in the panel is never a super admin, even if asked');

// Reset password, 2FA, sign out
const victimTok2 = (await login(`victim-${s}@example.com`, 'Password123!')).j.data.token;
r = await call(adminTok, 'POST', `/admin/users/${victimId}/reset-password`); const temp = r.j.data.temporaryPassword;
ok(r.status === 200 && temp, 'reset password gives a temporary one');
ok((await call(victimTok2, 'GET', '/projects')).status === 401, 'reset signs the person out');
ok((await login(`victim-${s}@example.com`, 'Password123!')).status === 401 && (await login(`victim-${s}@example.com`, temp)).status === 200, 'the old password stops working, the new one works');
await db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(victimId) }, { $set: { twoFactorEnabled: true } });
ok((await call(adminTok, 'POST', `/admin/users/${victimId}/disable-2fa`)).j.data.twoFactorEnabled === false, 'turn off two-step sign-in');
const t3 = (await login(`victim-${s}@example.com`, temp)).j.data.token;
r = await call(adminTok, 'POST', `/admin/users/${victimId}/sign-out`); ok(r.status === 200 && r.j.data.revoked >= 1 && (await call(t3, 'GET', '/projects')).status === 401, 'sign out everywhere');

// Delete (anonymise)
ok((await call(adminTok, 'DELETE', `/admin/users/${madeId}`, { confirmEmail: 'wrong@example.com' })).status === 400, 'delete needs the email typed');
r = await call(adminTok, 'DELETE', `/admin/users/${madeId}`, { confirmEmail: `made-${s}@example.com` }); ok(r.status === 200, 'delete a user');
const gone = await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(madeId) });
ok(gone.accountStatus === 'deleted' && gone.email.endsWith('@deleted.invalid') && !gone.password && !(await db.collection('workspacemembers').findOne({ userId: gone._id })), 'the account is anonymised and its memberships removed');
ok((await login(`made-${s}@example.com`, 'x')).status === 401, 'the old email can no longer sign in');
r = await call(adminTok, 'GET', '/admin/users?status=deleted&limit=100'); ok(r.j.data.users.some((u) => u.id === madeId), 'deleted accounts are listed under the Deleted filter');

// Analytics
r = await call(adminTok, 'GET', '/admin/analytics?days=30'); const a = r.j.data;
ok(r.status === 200 && a.series.days.length === 30 && a.series.signups.length === 30 && a.series.aiRuns.length === 30, 'analytics: 30 days of every series');
ok(a.totals.users >= 4 && a.totals.workspaces >= 1 && 'dau' in a.engagement && Array.isArray(a.tasks.byStatus) && 'errorRate' in a.ai, 'analytics: totals, engagement, tasks and AI');
ok(a.series.signups.reduce((x, y) => x + y, 0) >= 4 && a.series.signups.at(-1) >= 4, "today's signups are counted");
ok((await call(adminTok, 'GET', '/admin/analytics?days=7')).j.data.series.days.length === 7, 'a 7-day window gives 7 days');
ok((await call(adminTok, 'GET', '/admin/analytics?days=999')).j.data.days === 30, 'an odd window falls back to 30 days');

// Workspaces
r = await call(adminTok, 'GET', '/admin/workspaces?limit=5'); ok(r.status === 200 && r.j.data.workspaces.length >= 1 && 'members' in r.j.data.workspaces[0], 'workspaces list');
r = await call(adminTok, 'GET', `/admin/workspaces/${r.j.data.workspaces[0].id}`); ok(r.status === 200 && Array.isArray(r.j.data.members) && Array.isArray(r.j.data.projects), 'workspace detail');

// Audit
r = await call(adminTok, 'GET', '/admin/audit?limit=100'); const acts = new Set(r.j.data.entries.map((e) => e.action));
ok(['user.create', 'user.update', 'user.suspend', 'user.reactivate', 'user.reset_password', 'user.delete', 'user.make_super_admin', 'user.revoke_sessions', 'user.disable_2fa'].every((x) => acts.has(x)), 'every change is in the audit log');
r = await call(adminTok, 'GET', `/admin/audit?action=user.suspend&q=sadmin-${s}`); ok(r.j.data.entries.length >= 1 && r.j.data.entries.every((e) => e.action === 'user.suspend' && e.actorEmail === `sadmin-${s}@example.com`), 'audit filter by action, with who did it');
ok(!JSON.stringify((await call(adminTok, 'GET', '/admin/audit?limit=100')).j).includes(temp), 'temporary passwords are never written to the audit log');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
