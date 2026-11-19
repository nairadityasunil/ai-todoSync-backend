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
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
