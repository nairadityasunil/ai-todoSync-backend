// Platform admins manage the email templates; the app's real emails are built from them.
// Needs the server's log (mock mail mode prints "NOT SENT to <address> … [MOCK EMAIL] Subject: … | Text: …"): LOG=/path/to/backend.log
import fs from 'fs';
import mongoose from 'mongoose';
const API = process.env.API ?? 'http://localhost:4000/api';
const LOG = process.env.LOG ?? '/tmp/claude-0/backend.log';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const r = await fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/', { dbName: 'pristine' }); const db = mongoose.connection.db;
const admin = await reg('et-admin'), person = await reg('et-person');
await db.collection('users').updateOne({ email: `et-admin-${s}@example.com` }, { $set: { platformRole: 'super_admin' } });
const A = admin.token;
const mailLog = (to) => fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('[MOCK EMAIL]') && l.includes(`NOT SENT to ${to}`));
const waitMail = async (to, part) => { for (let i = 0; i < 24; i++) { if (mailLog(to).some((l) => l.includes(part))) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

ok((await call(person.token, 'GET', '/admin/email-templates')).status === 403, 'a normal person cannot open the template manager');
let r = await call(A, 'GET', '/admin/email-templates');
const codes = r.j.data.map((t) => t.code);
ok(r.status === 200 && ['PROJECT_INVITATION', 'PROJECT_ADDED', 'WORKSPACE_ADDED', 'TASK_ASSIGNED', 'LOGIN_2FA_CODE', 'PASSWORD_RESET_CODE'].every((c) => codes.includes(c)), 'the list has every template the app sends: ' + codes.join(', '));
const inv = r.j.data.find((t) => t.code === 'PROJECT_INVITATION');
ok(inv.variables.some((v) => v.key === 'projectName' && v.sample) && inv.canDisable === true, 'templates list their variables with samples');
ok(r.j.data.find((t) => t.code === 'LOGIN_2FA_CODE').canDisable === false, 'sign-in codes are marked as impossible to switch off');

r = await call(A, 'POST', '/admin/email-templates/PROJECT_INVITATION/preview', {});
ok(r.status === 200 && r.j.data.html.includes('Website redesign') && !/\{\{/.test(r.j.data.html), 'the preview fills the variables with sample values');
r = await call(A, 'POST', '/admin/email-templates/PROJECT_INVITATION/preview', { subject: 'Hi {{inviterName}} {{nope}}', html: '<p>{{projectName}} {{nope}}</p>' });
ok(r.j.data.subject === 'Hi Aditya Nair' && r.j.data.unknownVariables.join() === 'nope', 'a draft is previewed without saving, and unknown variables are named');
ok((await call(A, 'POST', '/admin/email-templates/PROJECT_INVITATION/preview', { html: '<script>alert(1)</script>' })).status === 400, 'scripts are refused');
ok((await call(A, 'PATCH', '/admin/email-templates/PROJECT_INVITATION', { subject: '   ' })).status === 400, 'an empty subject is refused');
ok((await call(A, 'PATCH', '/admin/email-templates/LOGIN_2FA_CODE', { isActive: false })).status === 400, 'a sign-in code email cannot be switched off');
ok((await call(A, 'GET', '/admin/email-templates/NOPE')).status === 404, 'an unknown template is a 404');
ok((await call(A, 'POST', '/admin/email-templates/PROJECT_INVITATION/test', { to: 'x@example.com' })).status === 400, 'a test send says when email is not set up (or sends when it is)');

// The real invitation uses the edited template
const proj = (await call(A, 'POST', '/projects', { name: '<b>Tpl</b> ' + s })).j.data.project;
r = await call(A, 'PATCH', '/admin/email-templates/PROJECT_INVITATION', { subject: 'Custom: {{projectName}} from {{inviterName}}', html: '<p>Join {{projectName}} here: {{acceptUrl}}</p>' });
ok(r.status === 200 && r.j.data.template.subject.startsWith('Custom:'), 'a template can be edited');
const nobody = `et-new-${s}@example.com`;
await call(A, 'POST', `/invitations/projects/${proj.id}`, { email: nobody });
ok(await waitMail(nobody, 'Subject: Custom: <b>Tpl</b> ' + s + ' from et-admin-'), 'the invitation email uses the edited subject (and the edited body)');
ok(mailLog(nobody).some((l) => l.includes('Join <b>Tpl</b> ' + s + ' here: http')), 'the edited body is used, with the accept link filled in');

// Switched off: nothing is sent
await call(A, 'PATCH', '/admin/email-templates/PROJECT_INVITATION', { isActive: false });
const quiet = `et-quiet-${s}@example.com`;
ok((await call(A, 'POST', `/invitations/projects/${proj.id}`, { email: quiet })).status === 201, 'the invitation is still created when its email is switched off');
await new Promise((r2) => setTimeout(r2, 2500));
ok(mailLog(quiet).length === 0, 'but no email is sent');

// Reset
r = await call(A, 'POST', '/admin/email-templates/PROJECT_INVITATION/reset');
ok(r.status === 200 && r.j.data.isActive === true && r.j.data.subject.startsWith('You have been invited'), 'reset restores the default and switches it back on');
const back = `et-back-${s}@example.com`;
await call(A, 'POST', `/invitations/projects/${proj.id}`, { email: back });
ok(await waitMail(back, 'Subject: You have been invited to join project: <b>Tpl</b>'), 'after the reset the default invitation is sent');
const audit = await db.collection('adminaudits').countDocuments({ actorEmail: `et-admin-${s}@example.com`, action: /^email-template/ });
ok(audit >= 3, 'every change is in the audit log (' + audit + ' entries)');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); await mongoose.disconnect(); process.exit(fails ? 1 : 0);
