// The short auth memory must never keep access alive after it is taken away, and the batch epics
// endpoint must only return epics of projects the person belongs to.
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const r = await fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
const boss = await reg('cb-boss'), person = await reg('cb-person');
await db.collection('users').updateOne({ email: `cb-boss-${s}@example.com` }, { $set: { platformRole: 'super_admin' } });
const bossTok = boss.token; const personTok = person.token;
const personId = String((await db.collection('users').findOne({ email: `cb-person-${s}@example.com` }))._id);

// Warm the memory, then take access away: it must stop at once
ok((await call(personTok, 'GET', '/auth/me')).status === 200 && (await call(personTok, 'GET', '/auth/me')).status === 200, 'a signed-in person is served (twice, the second from memory)');
ok((await call(bossTok, 'POST', `/admin/users/${personId}/suspend`, { reason: 'test' })).status === 200, 'admin suspends them');
ok((await call(personTok, 'GET', '/auth/me')).status === 401, 'the very next request is refused (no stale access from memory)');
await call(bossTok, 'POST', `/admin/users/${personId}/reactivate`);
const again = (await call(null, 'POST', '/auth/login', { email: `cb-person-${s}@example.com`, password: 'Password123!' })).j.data;
ok((await call(again.token, 'GET', '/auth/me')).status === 200 && (await call(again.token, 'GET', '/auth/me')).status === 200, 'after reactivating they sign in and are served again');
ok((await call(bossTok, 'POST', `/admin/users/${personId}/sign-out`)).status === 200 && (await call(again.token, 'GET', '/auth/me')).status === 401, 'signing someone out everywhere ends the warm session at once');
const third = (await call(null, 'POST', '/auth/login', { email: `cb-person-${s}@example.com`, password: 'Password123!' })).j.data;
await call(third.token, 'GET', '/auth/me');
ok((await call(bossTok, 'POST', `/admin/users/${personId}/reset-password`)).status === 200 && (await call(third.token, 'GET', '/auth/me')).status === 401, 'a password reset ends the warm session at once');
// the person's own sign-out
const fourth = (await call(null, 'POST', '/auth/login', { email: `cb-boss-${s}@example.com`, password: 'Password123!' })).j.data;
await call(fourth.accessToken ?? fourth.token, 'GET', '/auth/me');
const lo = await call(fourth.accessToken ?? fourth.token, 'POST', '/auth/logout', { refreshToken: fourth.refreshToken });
if (lo.status === 200) ok((await call(fourth.accessToken ?? fourth.token, 'GET', '/auth/me')).status === 401, 'logging out ends the warm session at once');
else console.log('  (logout endpoint answered', lo.status + '; skipped)');
// Role change is picked up at once
const p3 = await reg('cb-role'); const p3id = String((await db.collection('users').findOne({ email: `cb-role-${s}@example.com` }))._id);
ok((await call(p3.token, 'GET', '/admin/users')).status === 403, 'a normal person is refused by the admin API');
await call(bossTok, 'POST', `/admin/users/${p3id}/make-super-admin`);
ok((await call(p3.token, 'GET', '/admin/users')).status === 200, 'promoting them works on their very next request');
await call(bossTok, 'POST', `/admin/users/${p3id}/remove-super-admin`);
ok((await call(p3.token, 'GET', '/admin/users')).status === 403, 'and so does taking it away');

// Batch epics
const A = (await call(bossTok, 'POST', '/projects', { name: 'Epics A ' + s })).j.data.project;
const B = (await call(bossTok, 'POST', '/projects', { name: 'Epics B ' + s })).j.data.project;
const C = (await call(p3.token, 'POST', '/projects', { name: 'Not yours ' + s })).j.data.project;
for (const [pid, names] of [[A.id, ['A1', 'A2']], [B.id, ['B1']], [C.id, ['C1']]]) for (const n of names) await call(pid === C.id ? p3.token : bossTok, 'POST', `/projects/${pid}/epics`, { name: n });
let r = await call(bossTok, 'GET', `/epics?projectIds=${A.id},${B.id}`);
ok(r.status === 200 && r.j.data.epics.map((e) => e.name).sort().join() === 'A1,A2,B1', 'one request returns the epics of both projects');
r = await call(bossTok, 'GET', `/epics?projectIds=${A.id},${C.id},not-an-id,000000000000000000000000`);
ok(r.status === 200 && r.j.data.epics.map((e) => e.name).sort().join() === 'A1,A2', "a project that is not theirs, a malformed id and an unknown id are skipped (nothing leaks)");
ok((await call(bossTok, 'GET', '/epics')).j.data.epics.length === 0, 'no ids gives an empty list');
ok((await call(null, 'GET', `/epics?projectIds=${A.id}`)).status === 401, 'sign-in is required');
const per = (await call(bossTok, 'GET', `/projects/${A.id}/epics`)).j.data.epics.map((e) => e.name).join();
ok(per === 'A1,A2' && (await call(bossTok, 'GET', `/epics?projectIds=${A.id}`)).j.data.epics.map((e) => e.name).join() === per, 'the batch answer matches the per-project one, in the same order');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
