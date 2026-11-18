// Times the endpoints the portal calls on every load, so changes can be compared before and after.
// Usage: node e2e/perf/bench.mjs [rounds]
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const rounds = Number(process.argv[2] ?? 8);
const email = process.env.BENCH_EMAIL ?? 'qa@example.com';
const L = await (await fetch(API + '/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: 'Password123!' }) })).json();
const A = { ...H, authorization: 'Bearer ' + L.data.token };
const get = async (path) => { const t = performance.now(); const r = await fetch(API + path, { headers: A }); await r.arrayBuffer(); return { ms: performance.now() - t, status: r.status }; };
const projects = (await (await fetch(API + '/projects?limit=10', { headers: A })).json()).data.projects;
const p0 = projects[0]?.id;
const today = new Date().toISOString().slice(0, 10);
const ws = (await (await fetch(API + '/workspaces', { headers: A })).json()).workspaces?.[0]?.id;
const calls = [
  ['auth/me', '/auth/me'],
  ['projects (page of 10)', '/projects?page=1&limit=10'],
  ['tasks (a day)', `/tasks?date=${today}`],
  ['tasks (a project)', `/tasks?projectId=${p0}&date=${today}`],
  ['epics (one project)', `/projects/${p0}/epics`],
  ['project members', `/projects/${p0}/members`],
  ['project states', `/projects/${p0}/states`],
  ['workspaces', '/workspaces'],
  ['invitations/me', '/invitations/me'],
  ['agents approvals', '/agents/approvals?status=pending'],
  ['sla analytics', '/sla/analytics'],
  ['prompts (library)', ws ? `/workspaces/${ws}/prompts` : '/health'],
];
// the dashboard fans out one epics request per project
const epicsFanOut = async () => { const t = performance.now(); await Promise.all(projects.map((p) => get(`/projects/${p.id}/epics`))); return { ms: performance.now() - t, status: 200 }; };
const epicsBatch = async () => { const t = performance.now(); await get('/epics'); return { ms: performance.now() - t, status: 200 }; };
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return { p50: s[Math.floor(s.length / 2)], max: s[s.length - 1] }; };
const rows = [];
for (const [name, path] of calls) {
  const xs = []; let status = 0;
  await get(path); // warm up
  for (let i = 0; i < rounds; i++) { const r = await get(path); xs.push(r.ms); status = r.status; }
  rows.push({ name, status, ...stat(xs) });
}
{ const xs = []; await epicsFanOut(); for (let i = 0; i < rounds; i++) xs.push((await epicsFanOut()).ms); rows.push({ name: `epics fan-out (${projects.length} projects)`, status: 200, ...stat(xs) }); }
console.log('endpoint'.padEnd(36), 'status', 'p50 ms'.padStart(8), 'max ms'.padStart(8));
{ const xs = []; await epicsBatch(); for (let i = 0; i < rounds; i++) xs.push((await epicsBatch()).ms); rows.push({ name: `epics batch (${projects.length} projects, 1 request)`, status: 200, ...stat(xs) }); }
for (const r of rows) console.log(r.name.padEnd(36), String(r.status).padEnd(6), r.p50.toFixed(1).padStart(8), r.max.toFixed(1).padStart(8));
process.exit(0);
