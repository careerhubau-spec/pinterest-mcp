// Hosted Pinterest MCP server (Supabase Edge Function, Deno).
//
// Two jobs in one function:
//  1. An OAuth 2.1 authorization server for MCP clients (claude.ai custom connectors, Claude Desktop,
//     MCP Inspector): dynamic client registration, PKCE (S256 only), short-lived hashed tokens.
//     It delegates the actual login to Pinterest and keeps the Pinterest tokens encrypted server-side,
//     so the MCP client only ever holds *our* tokens, never the user's Pinterest credentials.
//  2. A stateless Streamable HTTP MCP endpoint at /mcp exposing the shared read-only tools.
//
// Routes (relative to BASE = <project>/functions/v1/pinterest-mcp):
//   GET  /.well-known/oauth-protected-resource      RFC 9728
//   GET  /.well-known/oauth-authorization-server     RFC 8414
//   GET  /.well-known/openid-configuration           (discovery fallback for path-based issuers)
//   POST /register                                   RFC 7591
//   GET  /authorize  -> Pinterest -> GET /callback -> client redirect_uri
//   POST /token                                      authorization_code | refresh_token (rotating)
//   POST /mcp                                        MCP (JSON-RPC over HTTP), Bearer required
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createPinterest, tokenExchange, SCOPES, PINTEREST_API, PINTEREST_OAUTH } from './shared/pinterest.mjs';
import { registerTools } from './shared/tools.mjs';
import { memoryStore, supabaseStore, type Store } from './store.ts';
import { decrypt, encrypt, initEncryption, randomToken, sha256 } from './crypto.ts';

const env = (k: string) => Deno.env.get(k) ?? '';
const BASE = (env('PUBLIC_BASE_URL') || `${env('SUPABASE_URL')}/functions/v1/pinterest-mcp`).replace(/\/$/, '');
const API = env('PINTEREST_API') || PINTEREST_API;
const OAUTH_URL = env('PINTEREST_OAUTH_URL') || PINTEREST_OAUTH;
const SCOPE = 'pinterest.read';
const TTL = { pending: 600, code: 300, access: 3600, refresh: 30 * 86400, grant: 90 * 86400, client: 365 * 86400 };

// Redirect URIs a client may register. Open DCR + allowlist = no consent-phishing via look-alike clients.
const ALLOWED_REDIRECTS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  ...env('PMCP_EXTRA_REDIRECTS').split(',').map((s) => s.trim()).filter(Boolean),
]);
function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (ALLOWED_REDIRECTS.has(u.origin + u.pathname)) return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); // loopback (RFC 8252)
  } catch { return false; }
}

initEncryption(env('PMCP_ENC_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'));
const storeP: Promise<Store> = env('PMCP_STORE') === 'memory'
  ? Promise.resolve(memoryStore())
  : supabaseStore(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));

type App = { client_id: string; client_secret: string };
let appCache: App | null = null;
async function pinterestApp(store: Store): Promise<App | null> {
  if (env('PINTEREST_CLIENT_ID')) return { client_id: env('PINTEREST_CLIENT_ID'), client_secret: env('PINTEREST_CLIENT_SECRET') };
  return appCache ??= await store.get<App>('config', 'pinterest');
}

// ---------- HTTP helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } });
const plain = (msg: string, status = 400) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const redirect = (url: URL | string) => new Response(null, { status: 302, headers: { Location: String(url), 'Cache-Control': 'no-store' } });
function backTo(redirectUri: string, state: string | null, params: Record<string, string>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (state) u.searchParams.set('state', state);
  return redirect(u);
}
const unauthorized = (description: string) => json({ error: 'invalid_token', error_description: description }, 401, {
  'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`,
});

// ---------- discovery ----------
const resourceMetadata = () => ({
  resource: `${BASE}/mcp`,
  authorization_servers: [BASE],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Pinterest (read-only)',
});
const authServerMetadata = () => ({
  issuer: BASE,
  authorization_endpoint: `${BASE}/authorize`,
  token_endpoint: `${BASE}/token`,
  registration_endpoint: `${BASE}/register`,
  scopes_supported: [SCOPE],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  // Fields required by OIDC discovery parsers. No ID tokens are issued; the JWKS is empty.
  jwks_uri: `${BASE}/jwks`,
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
});

// ---------- OAuth endpoints ----------
type Client = { client_id: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: string; secret_hash: string | null };

async function register(req: Request, store: Store) {
  let m: any;
  try { m = await req.json(); } catch { return oauthError('invalid_client_metadata', 'Body must be JSON'); }
  const uris = m?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && redirectAllowed(u))) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be claude.ai / claude.com MCP callbacks or loopback (localhost) URLs');
  }
  const method = m.token_endpoint_auth_method ?? 'client_secret_basic'; // RFC 7591 default
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
    return oauthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${method}`);
  }
  const client_id = `pmcp_${randomToken(16)}`;
  const client_secret = method === 'none' ? undefined : randomToken(32);
  const client: Client = {
    client_id, client_name: String(m.client_name || 'MCP client').slice(0, 100), redirect_uris: uris,
    token_endpoint_auth_method: method, secret_hash: client_secret ? await sha256(client_secret) : null,
  };
  await store.put('client', client_id, client, TTL.client);
  return json({
    client_id, client_secret, client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(client_secret ? { client_secret_expires_at: 0 } : {}),
    client_name: client.client_name, redirect_uris: uris, token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE,
  }, 201);
}

async function authorize(url: URL, store: Store) {
  const p = url.searchParams;
  const client = await store.get<Client>('client', p.get('client_id') ?? '');
  if (!client) return plain('Unknown client_id. Remove and re-add the connector in your MCP client.');
  const ru = p.get('redirect_uri') ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (!ru || !client.redirect_uris.includes(ru)) return plain('redirect_uri is not registered for this client.');
  // From here on, errors go back to the (verified) client redirect URI.
  const state = p.get('state');
  if (p.get('response_type') !== 'code') return backTo(ru, state, { error: 'unsupported_response_type' });
  const challenge = p.get('code_challenge');
  if (!challenge || p.get('code_challenge_method') !== 'S256') {
    return backTo(ru, state, { error: 'invalid_request', error_description: 'PKCE with S256 is required' });
  }
  const app = await pinterestApp(store);
  if (!app) return backTo(ru, state, { error: 'server_error', error_description: 'Pinterest app is not configured on this server' });

  const pendingId = randomToken(24);
  await store.put('pending', pendingId, { client_id: client.client_id, redirect_uri: ru, code_challenge: challenge, state }, TTL.pending);
  const pu = new URL(OAUTH_URL);
  pu.search = new URLSearchParams({ client_id: app.client_id, redirect_uri: `${BASE}/callback`, response_type: 'code', scope: SCOPES, state: pendingId }).toString();
  return redirect(pu);
}

async function callback(url: URL, store: Store) {
  const p = url.searchParams;
  const pend = await store.take<any>('pending', p.get('state') ?? '');
  if (!pend) return plain('This sign-in link has expired or was already used. Start again from your MCP client.');
  if (p.get('error') || !p.get('code')) {
    return backTo(pend.redirect_uri, pend.state, { error: 'access_denied', error_description: 'Pinterest access was not approved' });
  }
  const app = (await pinterestApp(store))!;
  let tok;
  try {
    tok = await tokenExchange({ clientId: app.client_id, clientSecret: app.client_secret, apiBase: API,
      params: { grant_type: 'authorization_code', code: p.get('code')!, redirect_uri: `${BASE}/callback` } });
  } catch (e) {
    console.error('pinterest code exchange failed', (e as Error).message);
    return backTo(pend.redirect_uri, pend.state, { error: 'server_error', error_description: 'Pinterest token exchange failed' });
  }
  let user = 'unknown';
  try { user = (await createPinterest({ getToken: async () => tok.access_token, apiBase: API }).api('/user_account')).username; } catch { /* non-fatal */ }

  const grantId = crypto.randomUUID();
  await store.put('grant', grantId, { user, client_id: pend.client_id, tokens: await encrypt(tok), created: Date.now() }, TTL.grant);
  const code = randomToken(32);
  await store.put('code', await sha256(code), {
    grant_id: grantId, client_id: pend.client_id, redirect_uri: pend.redirect_uri, code_challenge: pend.code_challenge,
  }, TTL.code);
  console.log(`granted pinterest user=${user} client=${pend.client_id}`);
  return backTo(pend.redirect_uri, pend.state, { code });
}

async function issueTokens(store: Store, grantId: string, clientId: string) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  await store.put('access', await sha256(access), { grant_id: grantId, client_id: clientId }, TTL.access);
  await store.put('refresh', await sha256(refresh), { grant_id: grantId, client_id: clientId }, TTL.refresh);
  return { access_token: access, token_type: 'Bearer', expires_in: TTL.access, refresh_token: refresh, scope: SCOPE };
}

async function token(req: Request, store: Store) {
  const ct = req.headers.get('content-type') ?? '';
  const raw = await req.text();
  let body: Record<string, string>;
  try { body = ct.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { return oauthError('invalid_request', 'Unreadable body'); }

  let clientId = body.client_id;
  let clientSecret = body.client_secret;
  const basic = req.headers.get('authorization');
  if (basic?.startsWith('Basic ')) {
    try {
      const [i, s] = atob(basic.slice(6)).split(':');
      clientId = decodeURIComponent(i); clientSecret = decodeURIComponent(s ?? '');
    } catch { return oauthError('invalid_client', 'Malformed Basic auth', 401); }
  }
  const client = clientId ? await store.get<Client>('client', clientId) : null;
  if (!client) return oauthError('invalid_client', 'Unknown client', 401);
  if (client.secret_hash && (!clientSecret || await sha256(clientSecret) !== client.secret_hash)) {
    return oauthError('invalid_client', 'Bad client credentials', 401);
  }

  if (body.grant_type === 'authorization_code') {
    const c = await store.take<any>('code', await sha256(body.code ?? '')); // single use
    if (!c || c.client_id !== client.client_id) return oauthError('invalid_grant', 'Code is invalid, expired or already used');
    if (body.redirect_uri && body.redirect_uri !== c.redirect_uri) return oauthError('invalid_grant', 'redirect_uri mismatch');
    if (!body.code_verifier || await sha256(body.code_verifier) !== c.code_challenge) return oauthError('invalid_grant', 'PKCE verification failed');
    return json(await issueTokens(store, c.grant_id, client.client_id));
  }
  if (body.grant_type === 'refresh_token') {
    const r = await store.take<any>('refresh', await sha256(body.refresh_token ?? '')); // rotation: old one dies
    if (!r || r.client_id !== client.client_id) return oauthError('invalid_grant', 'Refresh token is invalid, expired or already used');
    if (!await store.get('grant', r.grant_id)) return oauthError('invalid_grant', 'This Pinterest connection was removed');
    return json(await issueTokens(store, r.grant_id, client.client_id));
  }
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

// ---------- MCP endpoint ----------
async function mcp(req: Request, store: Store) {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return unauthorized('Sign in required');
  const at = await store.get<any>('access', await sha256(m[1]));
  if (!at) return unauthorized('Access token is invalid or expired');

  // Pinterest access token for this grant, decrypted on demand and refreshed if close to expiry.
  let cached: string | undefined;
  const getToken = async () => {
    if (cached) return cached;
    const g = await store.get<any>('grant', at.grant_id);
    if (!g) throw new Error('This Pinterest connection was removed. Reconnect the connector.');
    let tok = await decrypt<any>(g.tokens);
    if (Date.now() > tok.expires_at - 3600_000) {
      const app = (await pinterestApp(store))!;
      tok = await tokenExchange({ clientId: app.client_id, clientSecret: app.client_secret, apiBase: API,
        params: { grant_type: 'refresh_token', refresh_token: tok.refresh_token } });
      await store.put('grant', at.grant_id, { ...g, tokens: await encrypt(tok) }, TTL.grant);
    }
    return (cached = tok.access_token);
  };

  const server = new McpServer({ name: 'pinterest', version: '1.1.0' });
  registerTools(server, createPinterest({ getToken, apiBase: API }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

const PRIVACY = `Pinterest MCP (read-only) - Privacy Policy
Last updated: 2026-11-11

What this service is
Pinterest MCP is a read-only connector that lets an AI assistant (such as Claude) read the
Pinterest boards and pins of the person who signs in. It cannot create, edit or delete anything.

What data it accesses
Only the signed-in account's own boards, board sections, pins and basic profile (username),
using the scopes boards:read, boards:read_secret, pins:read, pins:read_secret, user_accounts:read.
It never accesses other people's private data.

How data is used
Board and pin data is fetched on demand when the assistant calls a tool and is passed straight
back to that assistant session. It is not stored, sold, shared, used for advertising, or used to
train models by this service.

What is stored
Only what is needed to keep you signed in: your Pinterest access and refresh tokens, encrypted
at rest (AES-256-GCM), and this service's own session tokens, stored as one-way hashes. Tokens
expire automatically (access 1 hour, refresh 30 days, sign-in grant 90 days).

Revoking access
Remove the connector in your AI client, or revoke the app in Pinterest under
Settings > Security and logins > Apps. Revoked or expired tokens are deleted.

Contact
Open an issue at https://github.com/careerhubau-spec/pinterest-mcp
`;

// ---------- router ----------
async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  // Supabase passes "/pinterest-mcp/..."; local runs see "/functions/v1/pinterest-mcp/...". Anything else is not ours.
  const m = url.pathname.match(/^(?:\/functions\/v1)?\/pinterest-mcp(\/.*)?$/);
  if (!m) return json({ error: 'not_found' }, 404);
  const path = (m[1] ?? '/').replace(/(.)\/$/, '$1');
  const store = await storeP;
  if (Math.random() < 0.02) store.sweep().catch((e) => console.error('sweep', e.message));

  const get = req.method === 'GET';
  if (get && path.startsWith('/.well-known/oauth-protected-resource')) return json(resourceMetadata());
  if (get && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) return json(authServerMetadata());
  if (get && path === '/jwks') return json({ keys: [] });
  if (path === '/register' && req.method === 'POST') return register(req, store);
  if (path === '/authorize' && get) return authorize(url, store);
  if (path === '/callback' && get) return callback(url, store);
  if (path === '/token' && req.method === 'POST') return token(req, store);
  if (path === '/mcp' || (path === '/' && req.method === 'POST')) return mcp(req, store);
  if (path === '/privacy' && get) return new Response(PRIVACY, { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
  if (path === '/' && get) return json({ name: 'Pinterest MCP (read-only)', mcp_url: `${BASE}/mcp`, docs: 'https://github.com/careerhubau-spec/pinterest-mcp' });
  return json({ error: 'not_found' }, 404);
}

const serve = async (req: Request) => {
  try { return await handle(req); } catch (e) {
    console.error('unhandled', (e as Error).stack ?? e);
    return json({ error: 'server_error', error_description: 'Unexpected error' }, 500);
  }
};
if (env('PORT')) Deno.serve({ port: Number(env('PORT')) }, serve);
else Deno.serve(serve);
