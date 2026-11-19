// Comments: the author and a project admin can edit or delete; other members cannot; outsiders cannot see or post.
const API = process.env.API ?? 'http://localhost:4000/api';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { 'content-type': 'application/json', 'user-agent': UA, origin: 'http://localhost:5173', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
let fails = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) fails++; };
const call = async (tok, method, path, body) => { const send = () => fetch(API + path, { method, headers: { ...H, ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let r; try { r = await send(); } catch { r = await send(); } let j = {}; try { j = await r.json(); } catch {} return { status: r.status, j }; };
const s = Date.now().toString(36);
const reg = async (n) => { await call(null, 'POST', '/auth/register', { email: `${n}-${s}@example.com`, password: 'Password123!', name: n }); return (await call(null, 'POST', '/auth/login', { email: `${n}-${s}@example.com`, password: 'Password123!' })).j.data; };
const A = await reg('cm-a'), B = await reg('cm-b'), C = await reg('cm-c'), X = await reg('cm-x');
const proj = (await call(A.token, 'POST', '/projects', { name: 'Comments ' + s })).j.data.project;
for (const [U, e] of [[B, 'cm-b'], [C, 'cm-c']]) { await call(A.token, 'POST', `/invitations/projects/${proj.id}`, { email: `${e}-${s}@example.com` }); await call(U.token, 'POST', '/invitations/accept', { token: (await call(U.token, 'GET', '/invitations/me')).j.data[0].token }); }
const t = (await call(A.token, 'POST', '/tasks', { title: 'T ' + s, projectId: proj.id })).j.data.task;
const base = `/tasks/${t.id}/comments`;

let r = await call(B.token, 'POST', base, { content: 'first by B' }); const cB = r.j.data.comment;
ok(r.status === 201 && cB.canModify === true && cB.editedAt === null, 'a member posts a comment and can modify it');
r = await call(C.token, 'POST', base, { content: 'by C' }); const cC = r.j.data.comment;
let list = (await call(A.token, 'GET', base)).j.data.comments;
ok(list.length === 2 && list.every((c) => c.canModify === true), 'the project admin can modify every comment');
list = (await call(B.token, 'GET', base)).j.data.comments;
ok(list.find((c) => c.id === cB.id).canModify === true && list.find((c) => c.id === cC.id).canModify === false, "a member can modify their own comment, not someone else's");

r = await call(B.token, 'PATCH', `${base}/${cB.id}`, { content: 'edited by B' });
ok(r.status === 200 && r.j.data.comment.content === 'edited by B' && r.j.data.comment.editedAt, 'the author edits their comment and it is marked edited');
r = await call(B.token, 'PATCH', `${base}/${cC.id}`, { content: 'hijack' });
ok(r.status === 403, "another member cannot edit someone else's comment");
r = await call(B.token, 'DELETE', `${base}/${cC.id}`);
ok(r.status === 403, "another member cannot delete someone else's comment");
r = await call(A.token, 'PATCH', `${base}/${cC.id}`, { content: 'moderated by admin' });
ok(r.status === 200 && r.j.data.comment.content === 'moderated by admin', "the project admin edits another member's comment");
r = await call(B.token, 'PATCH', `${base}/${cB.id}`, { content: '   ' });
ok(r.status === 400, 'an empty edit is refused');
r = await call(A.token, 'PATCH', `${base}/${cB.id}`, { content: 'edited by B' });
ok(r.status === 200 && r.j.data.comment.content === 'edited by B', 'saving unchanged text is accepted');

ok((await call(X.token, 'GET', base)).status === 404, 'someone outside the project cannot read the comments');
ok((await call(X.token, 'POST', base, { content: 'let me in' })).status === 404, 'or post one');
ok((await call(X.token, 'PATCH', `${base}/${cB.id}`, { content: 'x' })).status === 404, 'or edit one');
ok((await call(X.token, 'DELETE', `${base}/${cB.id}`)).status === 404, 'or delete one');
// a comment id from another task is not reachable through this task
const t2 = (await call(A.token, 'POST', '/tasks', { title: 'T2 ' + s, projectId: proj.id })).j.data.task;
ok((await call(A.token, 'DELETE', `/tasks/${t2.id}/comments/${cB.id}`)).status === 404, "a comment cannot be changed through a different task");

r = await call(A.token, 'DELETE', `${base}/${cC.id}`);
ok(r.status === 200, "the project admin deletes another member's comment");
r = await call(B.token, 'DELETE', `${base}/${cB.id}`);
ok(r.status === 200, 'the author deletes their own comment');
ok((await call(A.token, 'GET', base)).j.data.comments.length === 0, 'both are gone');
// personal task (no project): only the owner has access
const pt = (await call(X.token, 'POST', '/tasks', { title: 'mine ' + s })).j.data.task;
ok((await call(X.token, 'POST', `/tasks/${pt.id}/comments`, { content: 'note to self' })).status === 201, 'the owner of a personal task can comment');
ok((await call(A.token, 'GET', `/tasks/${pt.id}/comments`)).status === 404, "and nobody else can read a personal task's comments");
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
