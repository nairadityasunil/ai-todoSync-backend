// Service worker: asks the Pristine server about AI sites, blocks prohibited ones, and inspects pasted text.
// Listeners below must be registered synchronously, so the list is loaded on first use.
let hostsPromise;
const loadHosts = () => (hostsPromise ??= fetch(chrome.runtime.getURL('hosts.json')).then((r) => r.json()));
const ASK_EVERY_MS = 5 * 60 * 1000;
const asked = new Map();

const isAi = async (host) => (await loadHosts()).some((h) => host === h || host.endsWith(`.${h}`));
const settings = async () => {
  const s = await chrome.storage.sync.get({ server: '', token: '', user: '' });
  return { server: s.server.replace(/\/+$/, ''), token: s.token.trim(), user: s.user.trim() };
};

async function api(path, init = {}) {
  const { server, token } = await settings();
  if (!server || !token) throw new Error('not configured');
  const res = await fetch(`${server}/api/shadow-ai${path}`, { ...init, headers: { 'x-shadow-ai-token': token, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`server answered ${res.status}`);
  return res;
}

/** Block the prohibited sites even before the page loads, from the blocklist the server publishes. */
async function refreshBlocklist() {
  try {
    const text = await (await api('/ingest/blocklist')).text();
    const hosts = text.split('\n').map((h) => h.trim()).filter(Boolean);
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: old.map((r) => r.id),
      addRules: hosts.map((host, i) => ({
        id: i + 1,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?host=${encodeURIComponent(host)}` } },
        condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
      })),
    });
    await chrome.storage.local.set({ blocked: hosts.length, blocklistAt: Date.now(), lastError: '' });
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message ?? e) });
  }
}

/** Ask the server about an AI site and show the answer on the toolbar icon. */
async function check(tabId, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!(await isAi(host))) return;
  const last = asked.get(host) ?? 0;
  if (Date.now() - last < ASK_EVERY_MS) return;
  asked.set(host, Date.now());
  try {
    const { user } = await settings();
    const res = await (await api(`/ingest/decision?host=${encodeURIComponent(host)}${user ? `&user=${encodeURIComponent(user)}` : ''}`)).json();
    const d = res.data;
    await chrome.storage.local.set({ [`site:${host}`]: d });
    const text = { sanctioned: 'OK', restricted: '!', prohibited: 'X', unreviewed: '?' }[d.status] ?? '';
    const color = { sanctioned: '#15803d', restricted: '#c2410c', prohibited: '#b91c1c', unreviewed: '#a16207' }[d.status] ?? '#64748b';
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    if (d.allowed === false) await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(`blocked.html?host=${encodeURIComponent(host)}`) });
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message ?? e) });
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' && tab.url) void check(tabId, tab.url);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'inspect') {
    (async () => {
      const { user } = await settings();
      const res = await api('/ingest/inspect', { method: 'POST', body: JSON.stringify({ host: msg.host, text: msg.text, user: user || undefined }) });
      reply({ ok: true, data: (await res.json()).data });
    })().catch((e) => reply({ ok: false, error: String(e.message ?? e) }));
    return true;
  }
  if (msg?.type === 'refresh') {
    refreshBlocklist().then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.type === 'site') {
    chrome.storage.local.get(`site:${msg.host}`).then((v) => reply(v[`site:${msg.host}`] ?? null));
    return true;
  }
  return false;
});

chrome.alarms.create('blocklist', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'blocklist') void refreshBlocklist(); });
chrome.runtime.onInstalled.addListener(() => void refreshBlocklist());
chrome.storage.onChanged.addListener((c, area) => { if (area === 'sync') { asked.clear(); void refreshBlocklist(); } });
