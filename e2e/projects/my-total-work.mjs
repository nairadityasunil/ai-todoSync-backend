// The signed-in person's own total working time per project and per week.
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
const A = await reg('tw-a'), B = await reg('tw-b');
const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const mondayOf = (d) => addDays(d, -((d.getUTCDay() + 6) % 7));
const mon = mondayOf(new Date(day(new Date()) + 'T00:00:00Z')); const lastMon = addDays(mon, -7);
const p1 = (await call(A.token, 'POST', '/projects', { name: 'Alpha ' + s })).j.data.project;
const p2 = (await call(A.token, 'POST', '/projects', { name: 'Beta ' + s })).j.data.project;
const p3 = (await call(A.token, 'POST', '/projects', { name: 'Idle ' + s })).j.data.project;
await call(A.token, 'POST', `/invitations/projects/${p1.id}`, { email: `tw-b-${s}@example.com` });
await call(B.token, 'POST', '/invitations/accept', { token: (await call(B.token, 'GET', '/invitations/me')).j.data[0].token });
const log = async (tok, p, d, m) => (await call(tok, 'POST', `/projects/${p.id}/time/entries`, { date: day(d), minutes: m })).status;
const today = new Date(day(new Date()) + 'T00:00:00Z');
// this week: Monday and Tuesday are never in the future relative to the guard (+1 day slack); use Monday and the same day as Monday+0
ok([await log(A.token, p1, mon, 60), await log(A.token, p1, mon, 30), await log(A.token, p2, mon, 45)].every((x) => x === 201 || x === 200), 'time is logged in two projects this week');
await log(B.token, p1, mon, 600); // someone else's time must not count
await log(A.token, p1, lastMon, 120);
await log(A.token, p3, addDays(lastMon, -7), 15);

let r = await call(A.token, 'GET', '/time/my-week');
let w = r.j.data;
ok(r.status === 200 && w.weekStart === day(mon) && w.days.length === 7, 'the current week starts on Monday ' + w?.weekStart);
ok(w.projects.length === 2 && w.projects[0].name === 'Alpha ' + s && w.projects[0].minutes === 90 && w.projects[1].name === 'Beta ' + s && w.projects[1].minutes === 45, 'it lists each project with its total, most time first: ' + w.projects.map((p) => `${p.name.split(' ')[0]} ${p.minutes}`).join(', '));
ok(w.totalMinutes === 135, 'and the week total (' + w.totalMinutes + ')');
ok(w.totalByDay[0] === 135 && w.totalByDay.slice(1).every((x) => x === 0) && w.projects[0].byDay[0] === 90, 'with the minutes of each day');
ok(!w.projects.some((p) => p.name.startsWith('Idle')), 'a project with no time this week is not listed');
ok(w.projects.find((p) => p.name.startsWith('Alpha')).minutes === 90, "someone else's time in the same project is not counted");

r = await call(A.token, 'GET', `/time/my-week?start=${day(addDays(lastMon, 3))}`);
w = r.j.data;
ok(r.status === 200 && w.weekStart === day(lastMon) && w.projects.length === 1 && w.projects[0].minutes === 120 && w.totalMinutes === 120, 'a past week (any day in it) shows that week: ' + w.projects.map((p) => `${p.name.split(' ')[0]} ${p.minutes}`).join(', '));
r = await call(A.token, 'GET', `/time/my-week?start=${day(addDays(lastMon, -7))}`);
ok(r.j.data.projects.length === 1 && r.j.data.projects[0].name.startsWith('Idle') && r.j.data.projects[0].minutes === 15, 'an earlier week shows the project that had time then');
r = await call(A.token, 'GET', `/time/my-week?start=${day(addDays(lastMon, -70))}`);
ok(r.status === 200 && r.j.data.projects.length === 0 && r.j.data.totalMinutes === 0, 'a week with no time has no projects and a zero total');
r = await call(A.token, 'GET', `/time/my-week?start=${day(addDays(mon, 14))}`);
ok(r.status === 400, 'upcoming weeks are refused');
ok((await call(A.token, 'GET', '/time/my-week?start=nonsense')).status === 400, 'a bad date is refused');
ok((await call(null, 'GET', '/time/my-week')).status === 401, 'signing in is required');
r = await call(B.token, 'GET', '/time/my-week'); ok(r.j.data.projects.length === 1 && r.j.data.totalMinutes === 600, "each person sees only their own time (B: " + r.j.data.totalMinutes + ")");

// grouped by workspace: every workspace the person is in, with the time in its projects
const mkWs = async (name) => { const r = (await call(A.token, 'POST', '/workspaces', { name })).j; const w = r.workspace ?? r.data; return w.id ?? w._id; };
const w2 = await mkWs('Second ' + s), w3 = await mkWs('Empty ' + s);
const p4 = (await call(A.token, 'POST', '/projects', { name: 'Gamma ' + s, workspaceId: w2 })).j.data.project;
await log(A.token, p4, mon, 75);
r = await call(A.token, 'GET', '/time/my-week'); w = r.j.data;
const byName = (n) => w.workspaces.find((x) => x.name.startsWith(n));
ok(Array.isArray(w.workspaces) && byName('Second ' + s) && byName('Empty ' + s), 'every workspace the person is in is listed: ' + w.workspaces.map((x) => `${x.name.split(' ')[0]} ${x.minutes}`).join(', '));
ok(byName('Second ' + s).minutes === 75 && byName('Second ' + s).projects.length === 1 && byName('Second ' + s).projects[0].name.startsWith('Gamma'), 'a workspace shows the time in its own projects');
ok(byName('Empty ' + s).minutes === 0 && byName('Empty ' + s).projects.length === 0, 'a workspace with no time is listed with 0 and no projects');
const home = w.workspaces.find((x) => x.projects.some((p) => p.name.startsWith('Alpha')));
ok(home && home.minutes === 135 && home.projects.length === 2 && !home.projects.some((p) => p.name.startsWith('Idle') || p.name.startsWith('Gamma')), "the first workspace holds Alpha and Beta only (no project without time, none from another workspace)");
ok(w.workspaces.reduce((n, x) => n + x.minutes, 0) === w.totalMinutes && w.totalMinutes === 210, 'the workspace totals add up to the week total (' + w.totalMinutes + ')');
ok(w.projects.length === 3, 'the flat project list still has all projects with time');
r = await call(B.token, 'GET', '/time/my-week'); const wb = r.j.data;
ok(wb.workspaces.length >= 2 && wb.workspaces.some((x) => x.minutes === 600 && x.projects.length === 1), "another person's view lists their own workspaces and their own time");
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
