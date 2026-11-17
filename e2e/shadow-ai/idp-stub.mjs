// Stand-in for the Google Admin SDK and Microsoft Graph, shaped like the real responses.
import http from 'node:http';
export const state = { revoked: false, googleBroken: false };
export const start = () => new Promise((resolve) => {
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const p = url.pathname;
      if (p === '/g/token') {
        if (state.googleBroken) return send(res, 401, { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' });
        const jwt = new URLSearchParams(body).get('assertion') ?? '';
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
        return claims.sub === 'admin@corp.com' ? send(res, 200, { access_token: 'g-token' }) : send(res, 400, { error: 'invalid_grant' });
      }
      if (p.startsWith('/g/dir')) {
        if (req.headers.authorization !== 'Bearer g-token') return send(res, 401, { error: { message: 'bad token' } });
        if (p === '/g/dir/users') return send(res, 200, { users: [{ primaryEmail: 'ada@corp.com' }, { primaryEmail: 'bob@corp.com' }] });
        const who = decodeURIComponent(p.split('/')[4]);
        if (state.revoked) return send(res, 200, { items: [] });
        return send(res, 200, { items: who === 'ada@corp.com' ? [{ displayText: 'Otter.ai', scopes: ['https://www.googleapis.com/auth/calendar'] }, { displayText: 'Slack', scopes: ['chat'] }] : [{ displayText: 'Fireflies.ai', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }] });
      }
      if (p === '/m/tenant-ok/oauth2/v2.0/token' || p === '/m/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token') {
        const f = new URLSearchParams(body);
        return f.get('client_secret') === 'right-secret-1' ? send(res, 200, { access_token: 'm-token' }) : send(res, 401, { error: 'invalid_client', error_description: 'Invalid client secret provided.' });
      }
      if (p.startsWith('/m/graph')) {
        if (req.headers.authorization !== 'Bearer m-token') return send(res, 401, { error: { message: 'bad token' } });
        if (p === '/m/graph/oauth2PermissionGrants') return send(res, 200, { value: [{ clientId: 'sp1', consentType: 'Principal', principalId: 'u1', scope: 'Mail.Read offline_access' }, { clientId: 'sp2', consentType: 'AllPrincipals', scope: 'User.Read' }] });
        if (p === '/m/graph/servicePrincipals') return send(res, 200, { value: [{ id: 'sp1', displayName: 'ChatGPT' }, { id: 'sp2', displayName: 'Microsoft Teams' }] });
        if (p === '/m/graph/users/u1') return send(res, 200, { mail: 'carol@corp.com' });
      }
      send(res, 404, { error: { message: 'not found ' + p } });
    });
  });
  srv.listen(4555, '127.0.0.1', () => resolve(srv));
});
