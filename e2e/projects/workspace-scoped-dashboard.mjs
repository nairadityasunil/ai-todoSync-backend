// The dashboard data can be limited to one workspace; "Avg resolve" comes from logged time.
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
const A = await reg('wd-a');
const mkWs = async (name) => { const r = (await call(A.token, 'POST', '/workspaces', { name })).j; const w = r.workspace ?? r.data; return w.id ?? w._id; };
const w1 = await mkWs('One ' + s), w2 = await mkWs('Two ' + s);
const p1 = (await call(A.token, 'POST', '/projects', { name: 'P1 ' + s, workspaceId: w1 })).j.data.project;
const p2 = (await call(A.token, 'POST', '/projects', { name: 'P2 ' + s, workspaceId: w2 })).j.data.project;
const task = async (title, projectId) => (await call(A.token, 'POST', '/tasks', { title, ...(projectId ? { projectId } : {}) })).j.data.task;
const ta = await task('in-one ' + s, p1.id), tb = await task('in-two ' + s, p2.id), tp = await task('personal ' + s, null);
const titles = async (q) => ((await call(A.token, 'GET', '/tasks' + q)).j.data.tasks).map((t) => t.title).filter((t) => t.endsWith(s) && /^(in-|personal )/.test(t)).sort();

ok(JSON.stringify(await titles('')) === JSON.stringify([`in-one ${s}`, `in-two ${s}`, `personal ${s}`].sort()), 'with no workspace given the list is unchanged (everything)');
ok(JSON.stringify(await titles(`?workspaceId=${w1}`)) === JSON.stringify([`in-one ${s}`, `personal ${s}`].sort()), "workspace One: its project's task and the person's own task with no project, not the other workspace's");
ok(JSON.stringify(await titles(`?workspaceId=${w2}`)) === JSON.stringify([`in-two ${s}`, `personal ${s}`].sort()), "workspace Two: only its own project's task (plus the personal one)");
const gov = async (q) => ((await call(A.token, 'GET', '/tasks' + q)).j.data.tasks).filter((t) => t.title.startsWith('Set up governance') && t.title.endsWith(s)).map((t) => t.title.split(' ')[4]).sort();
ok(JSON.stringify(await gov(`?workspaceId=${w1}`)) === JSON.stringify(['P1']) && JSON.stringify(await gov(`?workspaceId=${w2}`)) === JSON.stringify(['P2']), 'the automatic governance tasks follow their own workspace too');
ok((await call(A.token, 'GET', `/tasks?workspaceId=${w1}&search=in-two`)).j.data.tasks.length === 0, 'search inside a workspace does not reach the other workspace');

const e1 = (await call(A.token, 'POST', `/projects/${p1.id}/epics`, { name: 'E1 ' + s })).j.data.epic, e2 = (await call(A.token, 'POST', `/projects/${p2.id}/epics`, { name: 'E2 ' + s })).j.data.epic;
const epicNames = async (q) => ((await call(A.token, 'GET', '/epics' + q)).j.data.epics).map((e) => e.name).filter((n) => n.endsWith(s)).sort();
ok((await epicNames('')).length === 2, 'epics: both without a workspace');
ok(JSON.stringify(await epicNames(`?workspaceId=${w1}`)) === JSON.stringify([`E1 ${s}`]), 'epics: only the open workspace\'s');

// Avg resolve = time people logged on resolved tasks
const a0 = (await call(A.token, 'GET', `/sla/analytics?projectId=${p1.id}`)).j.data.summary;
ok(a0.averageResolutionTimeHours === 0 && a0.resolvedTasksWithTime === 0, 'with no resolved tasks there is nothing to average (0 / 0)');
const t1 = await task('r1 ' + s, p1.id), t2 = await task('r2 ' + s, p1.id), t3 = await task('r3 ' + s, p1.id), t4 = await task('open ' + s, p1.id);
for (const t of [t1, t2, t3]) await call(A.token, 'PATCH', `/tasks/${t.id}`, { status: 'DONE' });
const a1 = (await call(A.token, 'GET', `/sla/analytics?projectId=${p1.id}`)).j.data.summary;
ok(a1.averageResolutionTimeHours === 0 && a1.resolvedTasksWithTime === 0, 'resolved tasks with no logged time do not produce an automatic average (they just finished: it stays 0)');
const today = new Date(); const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const log = (t, m) => call(A.token, 'POST', `/projects/${p1.id}/time/entries`, { date: day, minutes: m, taskId: t.id });
await log(t1, 120); await log(t1, 60); await log(t2, 60); await log(t4, 600); // t4 is still open: not part of it
const a2 = (await call(A.token, 'GET', `/sla/analytics?projectId=${p1.id}`)).j.data.summary;
ok(a2.averageResolutionTimeHours === 2 && a2.resolvedTasksWithTime === 2, 'avg resolve is the average logged time of resolved tasks with time: (180 + 60) / 2 = 2h (' + a2.averageResolutionTimeHours + 'h over ' + a2.resolvedTasksWithTime + ')');
ok(a2.resolutionCompliancePercent !== undefined, 'the other SLA numbers are still there');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
