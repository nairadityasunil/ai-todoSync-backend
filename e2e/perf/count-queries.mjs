// Counts database operations per request. Needs the backend started with the profiling shim that
// appends every Mongoose operation to /tmp/claude-0/queries.log (see the PR description).
import fs from 'fs';
const API = process.env.API ?? 'http://localhost:4000/api';
const LOG = process.env.QUERY_LOG ?? '/tmp/claude-0/queries.log';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const email = process.env.BENCH_EMAIL ?? 'qa@example.com';
const L = await (await fetch(API + '/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email, password: 'Password123!' }) })).json();
const A = { ...H, authorization: 'Bearer ' + L.data.token };
const projects = (await (await fetch(API + '/projects?limit=10', { headers: A })).json()).data.projects;
const p0 = projects[0].id; const today = new Date().toISOString().slice(0, 10);
const ws = (await (await fetch(API + '/workspaces', { headers: A })).json()).workspaces?.[0]?.id;
const lines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const paths = [
  '/auth/me', '/projects?page=1&limit=10', `/tasks?date=${today}`, `/tasks?projectId=${p0}&date=${today}`,
  `/projects/${p0}/epics`, `/projects/${p0}`, `/projects/${p0}/members`, `/projects/${p0}/states`, '/workspaces', '/invitations/me',
  '/agents/approvals?status=pending', '/sla/analytics', `/workspaces/${ws}/prompts`, `/projects/${p0}/time/week`,
];
const show = process.argv.includes('--detail');
for (const path of paths) {
  await fetch(API + path, { headers: A }); // warm up (caches, lazy seeding)
  const before = lines().length;
  const t = performance.now(); const r = await fetch(API + path, { headers: A }); await r.arrayBuffer(); const ms = performance.now() - t;
  const ops = lines().slice(before);
  const by = {}; for (const o of ops) { const k = o.split(' ')[0]; by[k] = (by[k] ?? 0) + 1; }
  console.log(`${String(ops.length).padStart(3)} ops  ${ms.toFixed(0).padStart(5)} ms  ${r.status}  ${path.replace(p0, ':p').replace(ws, ':ws')}`);
  if (show) for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`        ${n}x ${k}`);
}
process.exit(0);
