// Builds manifest.json from the AI tool catalog, so the extension only runs on AI sites.
// Run `npm run build` in the backend first (it reads dist/), then `node extensions/shadow-ai/build.mjs`.
import { writeFileSync } from 'node:fs';
import { CATALOG } from '../../dist/modules/shadow-ai/catalog.js';

const hosts = [...new Set(CATALOG.flatMap((t) => t.domains))].sort();
const matches = hosts.map((h) => `*://*.${h}/*`);
// With SHADOW_AI_SERVER set (e.g. https://api.example.com) the server is built in and no permission prompt is needed,
// which is how an organisation rolls the extension out. Without it, people are asked for permission when they save the address.
const server = process.env.SHADOW_AI_SERVER ? new URL(process.env.SHADOW_AI_SERVER).origin : '';
const manifest = {
  manifest_version: 3,
  name: 'Pristine Shadow AI',
  version: '1.0.0',
  description: 'Tells you whether an AI tool is approved, and checks what you paste into it for passwords, keys and personal data.',
  minimum_chrome_version: '116',
  permissions: ['storage', 'tabs', 'alarms', 'declarativeNetRequest'],
  ...(server ? { host_permissions: [`${server}/*`] } : { optional_host_permissions: ['http://*/*', 'https://*/*'] }),
  background: { service_worker: 'background.js', type: 'module' },
  options_ui: { page: 'options.html', open_in_tab: true },
  content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start', all_frames: false }],
  web_accessible_resources: [{ resources: ['blocked.html'], matches: ['<all_urls>'] }],
  action: { default_title: 'Pristine Shadow AI', default_popup: 'popup.html' },
};
writeFileSync(new URL('./hosts.json', import.meta.url), JSON.stringify(hosts, null, 2) + '\n');
writeFileSync(new URL('./manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest.json written for ${hosts.length} AI sites`);
