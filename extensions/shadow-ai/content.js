// Runs only on AI sites. Checks pasted text for passwords, keys, cards and personal data before it goes in.
(() => {
  const host = location.hostname;
  const banner = (html, tone) => {
    document.getElementById('pristine-shadow-banner')?.remove();
    const el = document.createElement('div');
    el.id = 'pristine-shadow-banner';
    el.setAttribute('role', 'alert');
    el.style.cssText = `position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);max-width:560px;padding:12px 16px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;color:#111;box-shadow:0 6px 24px rgba(0,0,0,.2);background:${tone === 'block' ? '#fee2e2' : '#fef3c7'};border:1px solid ${tone === 'block' ? '#fca5a5' : '#fcd34d'}`;
    el.textContent = html;
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.style.cssText = 'margin-left:12px;border:0;background:transparent;text-decoration:underline;cursor:pointer;font:inherit';
    close.onclick = () => el.remove();
    el.appendChild(close);
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 15000);
  };
  const describe = (d) => {
    const what = d.findings.map((f) => `${f.count} ${f.label.toLowerCase()}`).join(', ');
    const alt = d.alternative ? ` Use ${d.alternative} instead.` : '';
    return d.action === 'block'
      ? `Not pasted: it contains ${what}.${alt} ${d.message ?? ''}`.trim()
      : `Heads up: this contains ${what}. ${d.message ?? ''}`.trim();
  };

  document.addEventListener(
    'paste',
    (event) => {
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text.length < 6) return;
      const target = event.target;
      // Hold the paste until the server has answered, then put the text in ourselves if it is allowed.
      event.preventDefault();
      event.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'inspect', host, text }, (res) => {
        const d = res?.ok ? res.data : null;
        // If the server cannot be reached, do not get in the way of the person's work.
        if (d && d.action === 'block') return banner(describe(d), 'block');
        if (d && d.action === 'warn') banner(describe(d), 'warn');
        if (target instanceof HTMLElement) target.focus();
        document.execCommand('insertText', false, text);
      });
    },
    true,
  );
})();
