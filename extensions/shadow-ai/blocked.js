const host = new URLSearchParams(location.search).get('host') ?? '';
document.getElementById('title').textContent = `${host} is not allowed`;
chrome.runtime.sendMessage({ type: 'site', host }, (d) => {
  document.getElementById('why').textContent = d?.reason ? `Why: ${d.reason}` : 'Your organisation has prohibited this AI tool.';
  if (d?.alternative) { const a = document.getElementById('alt'); a.hidden = false; a.textContent = `Use this instead: ${d.alternative}`; }
  document.getElementById('msg').textContent = d?.message ?? '';
});
