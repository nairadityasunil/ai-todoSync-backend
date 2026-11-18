// Invitations create members only, accepting one opens the project's workspace, and the project list is per workspace.
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
const A = await reg('im-a'), B = await reg('im-b');
const wsr = (await call(A.token, 'POST', '/workspaces', { name: 'Team ' + s })).j; const ws = wsr.workspace ?? wsr.data; ws.id = ws.id ?? ws._id;
const p1 = (await call(A.token, 'POST', '/projects', { name: 'Shared ' + s, workspaceId: ws.id })).j.data.project;
const p2 = (await call(A.token, 'POST', '/projects', { name: 'Private ' + s, workspaceId: ws.id })).j.data.project;
const inv = await call(A.token, 'POST', `/invitations/projects/${p1.id}`, { email: `im-b-${s}@example.com`, role: 'ADMIN' });
ok(inv.status === 200 || inv.status === 201, 'A invites B asking for ADMIN');
const pending = (await call(B.token, 'GET', '/invitations/me')).j.data;
ok(pending.length === 1 && pending[0].role === 'MEMBER', 'the invitation is for MEMBER, not ADMIN');
const acc = await call(B.token, 'POST', '/invitations/accept', { token: pending[0].token });
ok(acc.status === 200 && acc.j.data.workspaceId === ws.id && acc.j.data.role === 'MEMBER', 'accepting answers with the project workspace and MEMBER');
const inWs = (await call(B.token, 'GET', `/projects?workspaceId=${ws.id}`)).j.data;
ok(inWs.projects.length === 1 && inWs.projects[0].id === p1.id, 'in the invited workspace B sees only the project they were invited to');
ok(inWs.projects[0].currentUserRole === 'MEMBER', 'and is a MEMBER of it');
const mine = await call(B.token, 'GET', '/workspaces');
const others = mine.j.workspaces.filter((w) => w.id !== ws.id);
for (const w of others) { const d = (await call(B.token, 'GET', `/projects?workspaceId=${w.id}`)).j.data; ok(!d.projects.some((p) => p.id === p1.id), `the project is not listed in B's other workspace (${w.name})`); }
ok(!inWs.projects.some((p) => p.id === p2.id), "A's other project in that workspace stays hidden from B");
const aList = (await call(A.token, 'GET', `/projects?workspaceId=${ws.id}`)).j.data;
ok(aList.projects.length === 2, 'A sees both projects in the workspace');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
