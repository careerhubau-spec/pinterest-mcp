// One-time Pinterest connection. node auth.mjs [--client-id X --client-secret Y]
// Stores app credentials + tokens in the login Keychain (service "pinterest-mcp").
import http from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { kcGet, kcSet, tokenRequest, SCOPES, REDIRECT, api } from './pinterest.mjs';
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
if (arg('--client-id')) kcSet('client_id', arg('--client-id'));
if (arg('--client-secret')) kcSet('client_secret', arg('--client-secret'));
if (process.argv.includes('--status')) {
  try { const u = await api('/user_account'); console.log(`connected as ${u.username} (${u.account_type})`); }
  catch (e) { console.log(`not connected: ${e.message}`); }
  process.exit(0);
}
if (!kcGet('client_id') || !kcGet('client_secret')) { console.log('Missing app credentials: node auth.mjs --client-id <id> --client-secret <secret>'); process.exit(1); }
const state = randomBytes(16).toString('hex');
const url = `https://www.pinterest.com/oauth/?${new URLSearchParams({ client_id: kcGet('client_id'), redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES, state })}`;
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:8085');
  if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
  if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) { res.end('Pinterest connection failed (state/code missing). You can close this tab.'); console.log('FAIL: bad callback', u.search); process.exit(1); }
  try {
    await tokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT });
    const me = await api('/user_account');
    res.end(`Connected to Pinterest as ${me.username}. You can close this tab.`);
    console.log(`OK: connected as ${me.username}`);
  } catch (e) { res.end('Pinterest connection failed: ' + e.message); console.log('FAIL:', e.message); }
  srv.close(); setTimeout(() => process.exit(0), 200);
});
srv.listen(8085, () => { console.log('Opening Pinterest to approve read-only access…\n' + url); execFile('open', [url]); });
setTimeout(() => { console.log('FAIL: timed out after 5 minutes'); process.exit(1); }, 300000);
