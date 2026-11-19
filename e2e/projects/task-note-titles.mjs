// A task can have several notes, each with a title and a (rich text) description.
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
const A = await reg('nt-a'), B = await reg('nt-b');
const proj = (await call(A.token, 'POST', '/projects', { name: 'Titles ' + s })).j.data.project;
await call(A.token, 'POST', `/invitations/projects/${proj.id}`, { email: `nt-b-${s}@example.com` });
await call(B.token, 'POST', '/invitations/accept', { token: (await call(B.token, 'GET', '/invitations/me')).j.data[0].token });
// an older task with a single plain note and no notes list
const t = (await call(A.token, 'POST', '/tasks', { title: 'T ' + s, projectId: proj.id, note: 'An older note written before titles existed, with a fairly long first sentence that keeps going and going past eighty characters.' })).j.data.task;
ok(t.notes.length === 1 && t.notes[0].title.length > 0 && t.notes[0].title.length <= 80 && t.notes[0].title.startsWith('An older note'), 'an older note shows the start of its text as its title: ' + t.notes[0].title);

let r = await call(A.token, 'POST', `/tasks/${t.id}/notes`, { title: '  Kickoff   decisions ', text: '<p>We chose <strong>Postgres</strong>. See <a href="https://example.com/adr">the ADR</a>.</p>' });
let notes = r.j.data.task.notes; let n = notes[notes.length - 1];
ok(r.status === 201 && n.title === 'Kickoff decisions', 'a note keeps its title (whitespace tidied): ' + n.title);
ok(n.text.includes('<strong>Postgres</strong>') && n.text.includes('href="https://example.com/adr"'), 'and its formatted description');
r = await call(A.token, 'POST', `/tasks/${t.id}/notes`, { text: '<p>No title given here at all</p>' });
n = r.j.data.task.notes.at(-1);
ok(r.status === 201 && n.title === 'No title given here at all', 'a note sent without a title gets one from its text: ' + n.title);
r = await call(A.token, 'POST', `/tasks/${t.id}/notes`, { title: 'x'.repeat(201), text: 'long title' });
ok(r.status === 400, 'a title over 200 characters is refused');
r = await call(A.token, 'POST', `/tasks/${t.id}/notes`, { title: 'Empty', text: '<p><br></p>' });
ok(r.status === 400, 'an empty description is refused');

const kick = notes.find((x) => x.title === 'Kickoff decisions');
r = await call(A.token, 'PATCH', `/tasks/${t.id}/notes/${kick.id}`, { title: 'Kickoff: final', text: '<p>Updated <em>text</em></p>' });
const upd = r.j.data.task.notes.find((x) => x.id === kick.id);
ok(r.status === 200 && upd.title === 'Kickoff: final' && upd.text.includes('<em>text</em>'), 'editing changes the title and the description');
r = await call(A.token, 'PATCH', `/tasks/${t.id}/notes/${kick.id}`, { text: '<p>Only the text changed</p>' });
ok(r.j.data.task.notes.find((x) => x.id === kick.id).title === 'Kickoff: final', 'editing without a title keeps the existing one');
r = await call(B.token, 'PATCH', `/tasks/${t.id}/notes/${kick.id}`, { title: 'hijack', text: '<p>x</p>' });
ok(r.status === 403, "a member cannot edit someone else's note");
r = await call(A.token, 'DELETE', `/tasks/${t.id}/notes/${kick.id}`);
ok(r.status === 200 && !r.j.data.task.notes.some((x) => x.id === kick.id), 'a note can be deleted');
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
