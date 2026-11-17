const $ = (id) => document.getElementById(id);
chrome.storage.sync.get({ server: '', token: '', user: '' }).then((s) => { $('server').value = s.server; $('token').value = s.token; $('user').value = s.user; });
$('save').onclick = async () => {
  const server = $('server').value.trim().replace(/\/+$/, '');
  const status = $('status');
  try {
    const origin = new URL(server).origin + '/*';
    const have = await chrome.permissions.contains({ origins: [origin] });
    if (!have && !(await chrome.permissions.request({ origins: [origin] }))) throw new Error('Permission to reach the server was not granted');
    await chrome.storage.sync.set({ server, token: $('token').value.trim(), user: $('user').value.trim() });
    await new Promise((r) => chrome.runtime.sendMessage({ type: 'refresh' }, r));
    const { lastError, blocked } = await chrome.storage.local.get(['lastError', 'blocked']);
    status.textContent = lastError ? `Saved, but the server said: ${lastError}` : `Connected. ${blocked ?? 0} prohibited site(s) blocked.`;
  } catch (e) { status.textContent = String(e.message ?? e); }
};
