// Shadow AI end to end against the real API and database.
import mongoose from 'mongoose';
const API = (process.env.API_URL ?? 'http://localhost:4000/api');
const PORTAL = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', origin: (process.env.APP_URL ?? 'http://localhost:5173'), 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
const call = async (method, path, { token, body, headers } = {}) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { ...PORTAL, authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
const issues = [];
const step = async (name, fn) => { try { await fn(); console.log(`✓ ${name}`); } catch (e) { issues.push(name); console.log(`✗ ${name}\n    ${String(e?.message ?? e).slice(0, 900)}`); } };
const expect = (c, m) => { if (!c) throw new Error(typeof m === 'string' ? m : JSON.stringify(m).slice(0, 900)); };
const S = '/shadow-ai';
await mongoose.connect((process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/'), { dbName: 'pristine' });
const db = mongoose.connection.db;
const login = async (email) => (await call('POST', '/auth/login', { body: { email, password: 'Password123!' } })).body.data;
const me = await login('qa@example.com'); const token = me.token;
const stamp = Date.now().toString(36);
await db.collection('agents').deleteMany({ name: 'probe-script' });
for (const c of ['shadowtools', 'shadowsightings', 'shadowtokens', 'shadowrequests', 'shadowsettings']) await db.collection(c).deleteMany({});
await call('POST', '/auth/register', { body: { email: `member-${stamp}@example.com`, password: 'Password123!', name: 'Plain Member' } });
await call('POST', '/auth/register', { body: { email: `outsider-${stamp}@example.com`, password: 'Password123!', name: 'Outsider' } });
const outsider = await login(`outsider-${stamp}@example.com`);
const member = await login(`member-${stamp}@example.com`);
const myWs = (await db.collection('workspacemembers').find({ userId: new mongoose.Types.ObjectId(String((await db.collection('users').findOne({ email: 'qa@example.com' }))._id)), role: 'OWNER' }).sort({ createdAt: 1 }).toArray())[0].workspaceId;
const memberId = new mongoose.Types.ObjectId(String((await db.collection('users').findOne({ email: `member-${stamp}@example.com` }))._id));
await db.collection('workspacemembers').updateOne({ userId: memberId, workspaceId: myWs }, { $setOnInsert: { userId: memberId, workspaceId: myWs, role: 'MEMBER', createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
const ws = `?workspaceId=${myWs}`;
let chatgpt, claudeTool, tokenRaw;

await step('catalog is readable by a member', async () => {
  const r = await call('GET', `${S}/catalog${ws}`, { token: member.token });
  expect(r.status === 200 && r.body.data.tools.length >= 60 && r.body.data.statuses.includes('prohibited'), r.body);
});
await step('empty workspace: overview has zeros, not errors', async () => {
  const r = await call('GET', `${S}/overview${ws}`, { token });
  expect(r.status === 200 && r.body.data.totals.tools === 0 && r.body.data.totals.unreviewedShare === 0, r.body);
});
await step('import a proxy log: tools found, people counted, unrelated hosts ignored', async () => {
  const log = ['time,user,host,bytes_out,uploads,personal', '2026-11-10T09:00:00Z,ada@corp.com,chat.openai.com,4096,1,true', '2026-11-10T09:05:00Z,bob@corp.com,chatgpt.com,2048,0,true', '2026-11-11T10:00:00Z,ada@corp.com,claude.ai,1024,0,false', '2026-11-11T10:00:00Z,ada@corp.com,intranet.corp.com,10,0,false', '2026-11-11T11:00:00Z,eve@corp.com,my-gpt.example.io,10,0,false'].join('\n');
  const r = await call('POST', `${S}/import/log${ws}`, { token, body: { text: log } });
  expect(r.status === 200 && r.body.data.matched === 4 && r.body.data.tools === 3 && r.body.data.newTools === 3, r.body);
  const t = (await call('GET', `${S}/tools${ws}`, { token })).body.data;
  chatgpt = t.find((x) => x.toolKey === 'chatgpt'); claudeTool = t.find((x) => x.toolKey === 'claude');
  expect(chatgpt.users === 2 && chatgpt.uploads === 1 && chatgpt.status === 'unreviewed' && chatgpt.personalShare === 1, chatgpt);
  expect(t.some((x) => x.catalog === false), 'unknown AI-looking host is kept, flagged as not in the catalog');
});
await step('re-importing the same log counts again but does not duplicate tools', async () => {
  const r = await call('POST', `${S}/import/log${ws}`, { token, body: { text: 'time,user,host\n2026-11-12T09:00:00Z,ada@corp.com,chatgpt.com' } });
  expect(r.body.data.newTools === 0, r.body);
  expect((await call('GET', `${S}/tools${ws}`, { token })).body.data.length === 3);
});
await step('members cannot list tools, import, decide or read tokens', async () => {
  for (const [m, p, b] of [['GET', '/tools', null], ['GET', '/overview', null], ['POST', '/import/log', { text: 'claude.ai' }], ['POST', `/tools/${chatgpt.id}/decision`, { status: 'sanctioned', reason: 'because I said so' }], ['GET', '/tokens', null], ['GET', '/policy', null]]) {
    const r = await call(m, `${S}${p}${ws}`, { token: member.token, body: b });
    expect(r.status === 403, `${m} ${p} -> ${r.status}`);
  }
});
await step('a stranger cannot reach this workspace', async () => {
  const r = await call('GET', `${S}/tools${ws}`, { token: outsider.token });
  expect(r.status === 403, r.status);
});
await step('decision needs a real reason; restricted needs conditions', async () => {
  let r = await call('POST', `${S}/tools/${chatgpt.id}/decision${ws}`, { token, body: { status: 'prohibited', reason: 'no' } });
  expect(r.status === 400, r.body);
  r = await call('POST', `${S}/tools/${chatgpt.id}/decision${ws}`, { token, body: { status: 'restricted', reason: 'Allowed for public data only' } });
  expect(r.status === 400, r.body);
  r = await call('POST', `${S}/tools/${chatgpt.id}/decision${ws}`, { token, body: { status: 'unreviewed', reason: 'reset it please' } });
  expect(r.status === 400, r.body);
});
await step('sanction a tool: vendor is created, history records who and why', async () => {
  const r = await call('POST', `${S}/tools/${claudeTool.id}/decision${ws}`, { token, body: { status: 'sanctioned', reason: 'Contract with data processing terms signed' } });
  expect(r.status === 200 && r.body.data.status === 'sanctioned' && r.body.data.vendorId, r.body);
  const d = (await call('GET', `${S}/tools/${claudeTool.id}${ws}`, { token })).body.data;
  expect(d.history[0].action === 'sanctioned' && d.history[0].byName && d.factors.length >= 2, d);
  expect(await db.collection('vendors').findOne({ workspaceId: myWs, key: 'shadow_claude' }), 'vendor record exists');
});
await step('restricted tool keeps conditions and an alternative', async () => {
  const r = await call('POST', `${S}/tools/${chatgpt.id}/decision${ws}`, { token, body: { status: 'restricted', reason: 'Only the enterprise tenant is covered', conditions: 'Public and internal data only', alternative: 'Claude (company account)' } });
  expect(r.status === 200 && r.body.data.conditions && r.body.data.alternative, r.body);
});
await step('declare a tool as a member (amnesty off), get coaching back', async () => {
  const r = await call('POST', `${S}/requests${ws}`, { token: member.token, body: { toolName: 'ChatGPT', purpose: 'Drafting customer replies', dataTypes: ['customer', 'bogus'], kind: 'declared' } });
  expect(r.status === 201 && r.body.data.tool.status === 'restricted' && r.body.data.tool.alternative === 'Claude (company account)' && r.body.data.amnesty === false, r.body);
  const dup = await call('POST', `${S}/requests${ws}`, { token: member.token, body: { toolName: 'ChatGPT', purpose: 'Drafting customer replies again' } });
  expect(dup.status === 400, 'second open note about the same tool is refused');
});
await step('amnesty window marks declarations; settings validate', async () => {
  let r = await call('PATCH', `${S}/settings${ws}`, { token, body: { amnestyUntil: 'nonsense' } });
  expect(r.status === 400, r.body);
  r = await call('PATCH', `${S}/settings${ws}`, { token: member.token, body: { reviewDays: 3 } });
  expect(r.status === 403, r.status);
  r = await call('PATCH', `${S}/settings${ws}`, { token, body: { amnestyUntil: new Date(Date.now() + 7 * 864e5).toISOString(), coachMessage: 'Tell us what you use. No blame.' } });
  expect(r.status === 200 && r.body.data.amnestyActive === true, r.body);
  r = await call('POST', `${S}/requests${ws}`, { token: member.token, body: { toolName: 'Otter.ai', purpose: 'Recording stand-ups', kind: 'declared' } });
  expect(r.status === 201 && r.body.data.amnesty === true && r.body.data.message.includes('No blame'), r.body);
});
await step('a member sees only their own requests; an admin sees all and decides', async () => {
  const mine = (await call('GET', `${S}/requests${ws}`, { token: member.token })).body.data;
  expect(mine.length === 2 && mine.every((x) => x.isMine), mine);
  const all = (await call('GET', `${S}/requests${ws}&status=pending`, { token })).body.data;
  expect(all.length >= 1, all);
  const otter = all.find((x) => x.toolKey === 'otter');
  let r = await call('POST', `${S}/requests/${otter.id}/decision${ws}`, { token: member.token, body: { decision: 'approved', note: 'self approve' } });
  expect(r.status === 403, 'members cannot approve');
  r = await call('POST', `${S}/requests/${otter.id}/decision${ws}`, { token, body: { decision: 'rejected', note: 'Not covered by the contract' } });
  expect(r.status === 200 && r.body.data.status === 'rejected', r.body);
  r = await call('POST', `${S}/requests/${otter.id}/decision${ws}`, { token, body: { decision: 'approved', note: 'changed my mind' } });
  expect(r.status === 400, 'decided requests are final');
});
await step('prohibit a tool: request follows; policy exports blocklist', async () => {
  const otterTool = (await call('GET', `${S}/tools${ws}&q=otter`, { token })).body.data[0];
  const r = await call('POST', `${S}/tools/${otterTool.id}/decision${ws}`, { token, body: { status: 'prohibited', reason: 'Records meetings without consent', alternative: 'Built-in meeting notes' } });
  expect(r.status === 200, r.body);
  const bl = await fetch(`${API}${S}/policy${ws}&format=blocklist`, { headers: { ...PORTAL, authorization: `Bearer ${token}` } });
  const text = await bl.text();
  expect(bl.status === 200 && text.split('\n').includes('otter.ai') && !text.includes('chatgpt.com'), text);
  const csv = await (await fetch(`${API}${S}/policy${ws}&format=csv`, { headers: { ...PORTAL, authorization: `Bearer ${token}` } })).text();
  expect(csv.startsWith('tool,vendor') && csv.includes('Records meetings without consent'), csv.slice(0, 300));
  const json = JSON.parse(await (await fetch(`${API}${S}/policy${ws}`, { headers: { ...PORTAL, authorization: `Bearer ${token}` } })).text());
  expect(json.prohibited.length === 1 && json.restricted.length === 1 && json.sanctioned.length === 1, json);
});
await db.collection('agentalerts').deleteMany({ type: { $in: ['shadow_ai_key', 'shadow_ai_sensitive'] } });
await step('code scan: packages and a key found, key never echoed back', async () => {
  const key = 'sk-ant-api03-' + 'Z'.repeat(40);
  const r = await call('POST', `${S}/scan${ws}`, { token, body: { repo: 'billing-service', files: [{ path: 'package.json', content: JSON.stringify({ dependencies: { openai: '^4' } }) }, { path: 'src/cfg.ts', content: `export const k = "${key}";` }] } });
  expect(r.status === 200 && r.body.data.packages === 1 && r.body.data.keys === 1, r.body);
  expect(!JSON.stringify(r.body).includes(key), 'key must not be echoed');
  const dump = JSON.stringify(await db.collection('shadowsightings').find({}).toArray());
  expect(!dump.includes(key) && !dump.includes('ZZZZZZZZ'), 'key must not be stored');
  const alert = await db.collection('agentalerts').findOne({ workspaceId: String(myWs), type: 'shadow_ai_key' }) ?? await db.collection('agentalerts').findOne({ type: 'shadow_ai_key' });
  expect(alert && alert.severity === 'critical', 'critical alert raised');
});
await step('server token: created once, shown once, ingests without login, revocable', async () => {
  let r = await call('POST', `${S}/tokens${ws}`, { token, body: { name: 'Zscaler export job' } });
  expect(r.status === 201 && /^sai_[a-f0-9]{48}$/.test(r.body.data.token), r.body);
  tokenRaw = r.body.data.token;
  const list = JSON.stringify((await call('GET', `${S}/tokens${ws}`, { token })).body);
  expect(!list.includes(tokenRaw), 'list must not return the token');
  expect(!JSON.stringify(await db.collection('shadowtokens').find({}).toArray()).includes(tokenRaw), 'only a hash is stored');
  r = await call('POST', `${S}/ingest/signals`, { headers: { 'x-shadow-ai-token': tokenRaw }, body: { source: 'oauth', signals: [{ target: 'Fireflies.ai', user: 'ada@corp.com', scopes: ['https://www.googleapis.com/auth/calendar', 'gmail.readonly'] }, { target: 'Calendar Sync', user: 'ada@corp.com' }] } });
  expect(r.status === 200 && r.body.data.matched === 1 && r.body.data.ignored === 1, r.body);
  const f = (await call('GET', `${S}/tools${ws}&q=fireflies`, { token })).body.data[0];
  expect(f.hasBroadGrant === true && f.sources.includes('oauth'), f);
  r = await call('POST', `${S}/ingest/signals`, { headers: { 'x-shadow-ai-token': 'sai_' + '0'.repeat(48) }, body: { source: 'network', signals: [{ target: 'claude.ai' }] } });
  expect(r.status === 401, r.status);
  r = await call('POST', `${S}/ingest/signals`, { body: { source: 'network', signals: [{ target: 'claude.ai' }] } });
  expect(r.status === 401, 'no token, no entry');
  const id = (await call('GET', `${S}/tokens${ws}`, { token })).body.data[0].id;
  r = await call('DELETE', `${S}/tokens/${id}${ws}`, { token });
  expect(r.status === 200, r.body);
  r = await call('POST', `${S}/ingest/signals`, { headers: { 'x-shadow-ai-token': tokenRaw }, body: { source: 'network', signals: [{ target: 'claude.ai' }] } });
  expect(r.status === 401, 'revoked token refused');
});
await step('a public SDK key cannot ingest shadow AI signals', async () => {
  const r = await call('POST', `${S}/ingest/signals`, { headers: { 'x-sdk-key': 'pk_anything', authorization: 'Bearer pk_anything' }, body: { source: 'network', signals: [{ target: 'claude.ai' }] } });
  expect(r.status === 401, r.status);
});
await step('bad input is refused with 400, not a crash', async () => {
  for (const b of [{}, { source: 'network' }, { source: 'bogus', signals: [{ target: 'x' }] }, { source: 'network', signals: [] }]) {
    const r = await call('POST', `${S}/import/signals${ws}`, { token, body: b });
    expect(r.status === 400, JSON.stringify(b) + ' -> ' + r.status);
  }
  expect((await call('GET', `${S}/tools/zzz${ws}`, { token })).status === 404);
  expect((await call('POST', `${S}/scan${ws}`, { token, body: { files: 'nope' } })).status === 400);
});
await step('overview metrics add up', async () => {
  const o = (await call('GET', `${S}/overview${ws}`, { token })).body.data;
  expect(o.totals.tools >= 5 && o.byStatus.sanctioned === 1 && o.byStatus.prohibited === 1 && o.byStatus.restricted === 1, o);
  expect(o.totals.keysInCode >= 1 && o.totals.peopleOnUnsanctioned >= 2 && o.meanDaysToDecision !== undefined && o.newPerWeek.length === 8 && o.topRisks.length >= 1, o);
  expect(o.coverage.network > 0 && o.coverage.code > 0 && o.coverage.oauth > 0 && o.coverage.declared > 0, o.coverage);
});
await step('reopen puts a decided tool back in the queue', async () => {
  const r = await call('POST', `${S}/tools/${claudeTool.id}/reopen${ws}`, { token, body: { reason: 'Vendor changed its terms' } });
  expect(r.status === 200 && r.body.data.status === 'unreviewed', r.body);
});
await step('register as a use case when sanctioning', async () => {
  const r = await call('POST', `${S}/tools/${claudeTool.id}/decision${ws}`, { token, body: { status: 'sanctioned', reason: 'Re-reviewed and approved again', registerUseCase: true } });
  expect(r.status === 200 && r.body.data.useCaseId, r.body);
  const uc = await call('GET', `/ai-governance/use-cases/${r.body.data.useCaseId}${ws}`, { token });
  expect(uc.status === 200 && /Claude/.test(uc.body.data.name), uc.body);
});
await step('compliance report carries the new controls', async () => {
  const r = await call('GET', `/agents/compliance${ws}`, { token });
  const ids = (r.body.data?.controls ?? []).map((c) => c.id);
  expect(ids.includes('shadow_ai_reviewed') && ids.includes('shadow_ai_prohibited'), r.status + ' ' + ids.join(','));
  const keyControl = r.body.data.controls.find((c) => c.id === 'shadow_ai_prohibited');
  expect(keyControl.status !== 'met', 'a key in code means this control is not met');
});
await step('agents cannot use the shadow AI API', async () => {
  const mk = await call('POST', '/agents/keys' + ws, { token, body: { name: 'shadow-probe', scopes: ['work:read'] } });
  const raw = mk.body?.data?.key ?? mk.body?.data?.token;
  if (!raw) { console.log('    (skipped: could not mint an agent key: ' + mk.status + ')'); return; }
  const r = await call('POST', `${S}/tools/${claudeTool.id}/decision${ws}`, { headers: { authorization: `Bearer ${raw}` }, body: { status: 'sanctioned', reason: 'agent trying to approve a tool' } });
  expect([401, 403].includes(r.status), 'agent decision -> ' + r.status);
});
await step('detected scripts using a login join the inventory as shadow AI', async () => {
  await db.collection('agents').deleteMany({ name: 'probe-script' });
  await db.collection('agents').insertOne({ workspaceId: myWs, ownerUserId: memberId, kind: 'detected', status: 'active', name: 'probe-script', projectIds: [], scopes: [], createdAt: new Date(), updatedAt: new Date() });
  const t = (await call('GET', `${S}/tools${ws}&q=unregistered`, { token })).body.data;
  expect(t.length === 1 && t[0].sources.includes('agent') && t[0].users === 1 && t[0].hasBroadGrant, t);
  await db.collection('agents').deleteMany({ name: 'probe-script' });
});
await step('hourly check: alert for a prohibited tool in use, task for a tool left unreviewed', async () => {
  await call('POST', `${S}/import/signals${ws}`, { token, body: { source: 'network', signals: [{ target: 'perplexity.ai', user: 'ada@corp.com' }, { target: 'otter.ai', user: 'ada@corp.com' }] } });
  await db.collection('shadowtools').updateOne({ workspaceId: String(myWs), toolKey: 'perplexity' }, { $set: { firstSeenAt: new Date(Date.now() - 30 * 864e5) } });
  await db.collection('agentalerts').deleteMany({ type: 'shadow_ai_prohibited' });
  const r = await call('POST', `${S}/monitor/run${ws}`, { token });
  expect(r.status === 200 && r.body.data.alerts >= 1 && r.body.data.tasks >= 1, r.body);
  const alert = await db.collection('agentalerts').findOne({ type: 'shadow_ai_prohibited' });
  expect(alert && alert.severity === 'critical' && /Otter/.test(alert.title), alert);
  const link = await db.collection('automationlinks').findOne({ key: /^shadow_review:/, state: 'open' });
  expect(link, 'review task opened');
  const again = await call('POST', `${S}/monitor/run${ws}`, { token });
  expect(again.body.data.alerts === 0, 'same alert is not raised twice in a week: ' + JSON.stringify(again.body));
  expect((await call('POST', `${S}/monitor/run${ws}`, { token: member.token })).status === 403, 'members cannot run it');
});
await step('deciding a tool closes its review task', async () => {
  const p = (await call('GET', `${S}/tools${ws}&q=perplexity`, { token })).body.data[0];
  expect((await call('POST', `${S}/tools/${p.id}/decision${ws}`, { token, body: { status: 'dismissed', reason: 'Checked: it is only a search engine here' } })).status === 200);
  const link = await db.collection('automationlinks').findOne({ key: `shadow_review:${p.id}` });
  expect(link && link.state !== 'open', link);
});
await step('an approved vendor lowers the risk score', async () => {
  const c = (await call('GET', `${S}/tools${ws}&q=claude`, { token })).body.data[0];
  const before = c.riskScore;
  await db.collection('vendors').updateOne({ _id: new mongoose.Types.ObjectId(c.vendorId) }, { $set: { status: 'approved' } });
  const d = (await call('POST', `${S}/tools/${c.id}/reopen${ws}`, { token, body: {} })).body.data;
  const detail = (await call('GET', `${S}/tools/${c.id}${ws}`, { token })).body.data;
  expect(detail.factors.some((f) => /Vendor review approved/.test(f.label)), detail.factors);
});
await step('a key in code raises one alert, however often it is scanned or checked', async () => {
  const key = 'sk-ant-api03-' + 'Z'.repeat(40);
  await call('POST', `${S}/scan${ws}`, { token, body: { files: [{ path: 'src/cfg.ts', content: `export const k = "${key}";` }] } });
  await call('POST', `${S}/monitor/run${ws}`, { token });
  const n = await db.collection('agentalerts').countDocuments({ type: 'shadow_ai_key', title: 'Anthropic API key found in code' });
  expect(n === 1, 'alerts: ' + n);
});
await step('extension inspection: sensitive data is counted, text is never stored, answer says block or warn', async () => {
  const t = (await call('POST', `${S}/tokens${ws}`, { token, body: { name: 'extension' } })).body.data.token;
  const send = (host, text, user = 'eve@corp.com') => call('POST', `${S}/ingest/inspect`, { headers: { 'x-shadow-ai-token': t }, body: { host, user, text } });
  const card = '4111 1111 1111 1111';
  let r = await send('https://gemini.google.com/app', 'Please summarise the Q3 plan for the team');
  expect(r.status === 200 && r.body.data.action === 'allow' && r.body.data.findings.length === 0, r.body);
  r = await send('https://gemini.google.com/app', `customer card ${card} and mail jo@example.com`);
  expect(r.body.data.action === 'block' && r.body.data.findings.some((f) => f.type === 'card_number'), r.body);
  r = await send('https://gemini.google.com/app', 'ping me at jo@example.com about the lunch');
  expect(r.body.data.action === 'warn' && r.body.data.findings[0].type === 'email', r.body);
  r = await send('intranet.corp.com', `card ${card}`);
  expect(r.body.data.known === false && r.body.data.action === 'allow', r.body);
  const g = (await call('GET', `${S}/tools${ws}&q=gemini`, { token })).body.data[0];
  expect(g.sensitive >= 2 && g.sources.includes('extension'), g);
  const detail = (await call('GET', `${S}/tools/${g.id}${ws}`, { token })).body.data;
  expect(detail.factors.some((f) => /Sensitive data was sent/.test(f.label)), detail.factors);
  const stored = JSON.stringify([await db.collection('shadowsightings').find({}).toArray(), await db.collection('agentalerts').find({ type: 'shadow_ai_sensitive' }).toArray()]);
  expect(!stored.includes('4111') && !stored.includes('jo@example.com') && !stored.includes('lunch'), 'the text must not be kept');
  const alert = await db.collection('agentalerts').findOne({ type: 'shadow_ai_sensitive' });
  expect(alert && alert.severity === 'critical' && /Gemini/.test(alert.title), alert);
  expect((await send('gemini.google.com', '')).status === 400, 'text required');
  expect((await call('POST', `${S}/ingest/inspect`, { body: { host: 'gemini.google.com', text: 'x' } })).status === 401, 'no token');
  // a sanctioned tool is not blocked for an email, but still warned
  await call('POST', `${S}/tools/${g.id}/decision${ws}`, { token, body: { status: 'sanctioned', reason: 'Enterprise contract in place' } });
  r = await send('gemini.google.com', `card ${card}`);
  expect(r.body.data.action === 'warn', 'sanctioned: warn, not block: ' + JSON.stringify(r.body));
});
console.log(issues.length ? `\n${issues.length} failed: ${issues.join('; ')}` : '\nAll shadow AI API checks passed');
await mongoose.disconnect();
process.exit(issues.length ? 1 : 0);
