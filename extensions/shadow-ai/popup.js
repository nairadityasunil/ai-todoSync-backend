(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const out = document.getElementById('out');
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { /* not a web page */ }
  const d = host ? await chrome.runtime.sendMessage({ type: 'site', host }) : null;
  if (!d) { out.textContent = 'This is not a known AI site, or has not been checked yet.'; return; }
  const label = { sanctioned: 'Approved', restricted: 'Allowed with conditions', prohibited: 'Not allowed', unreviewed: 'Not reviewed yet' }[d.status];
  out.innerHTML = '';
  const b = document.createElement('strong'); b.textContent = `${d.tool}: ${label}`; out.appendChild(b);
  for (const t of [d.conditions && `Conditions: ${d.conditions}`, d.alternative && `Use instead: ${d.alternative}`, d.message]) if (t) { const p = document.createElement('p'); p.textContent = t; out.appendChild(p); }
})();
