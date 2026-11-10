// Local-only credential storage: Pinterest app keys + OAuth tokens live in the macOS login Keychain.
import { execFileSync } from 'node:child_process';
import { tokenExchange } from './src/pinterest.mjs';

const SERVICE = 'pinterest-mcp';
export const REDIRECT = 'http://localhost:8085/callback';

export function kcGet(account) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
export function kcSet(account, value) {
  execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value], { stdio: 'ignore' });
}

export async function tokenRequest(params) {
  const tok = await tokenExchange({ clientId: kcGet('client_id'), clientSecret: kcGet('client_secret'), params });
  tok.refresh_token ||= JSON.parse(kcGet('token') || '{}').refresh_token;
  kcSet('token', JSON.stringify(tok));
  return tok;
}

// Returns a valid access token, refreshing it an hour before expiry.
export async function accessToken() {
  const tok = JSON.parse(kcGet('token') || 'null');
  if (!tok) throw new Error('Not connected to Pinterest yet. Run: npm run auth (in the pinterest-mcp folder)');
  if (Date.now() < tok.expires_at - 3600_000) return tok.access_token;
  return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).access_token;
}
