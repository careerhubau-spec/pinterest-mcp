// End-to-end test of the hosted server: real Deno function + mock Pinterest + the official MCP client
// doing full OAuth discovery, dynamic registration, PKCE and tool calls. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FN_DIR = new URL('../supabase/functions/pinterest-mcp/', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const b64url = (b) => b.toString('base64url');
const pkce = () => { const v = b64url(randomBytes(32)); return { verifier: v, challenge: b64url(createHash('sha256').update(v).digest()) }; };

// ---------- mock Pinterest ----------
let mockUrl;
const pinterestCalls = [];
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, mockUrl);
  pinterestCalls.push(u.pathname);
  const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  const pin = (id, title) => ({ id, title, description: `${title} desc`, note: 'love the type', link: 'https://example.com', board_id: 'b1',
    media: { media_type: 'image', images: { '600x': { url: `${mockUrl}/img/${id}.png`, width: 600, height: 400 }, originals: { url: `${mockUrl}/img/${id}.png`, width: 1200, height: 800 } } } });
  if (u.pathname === '/oauth/') {
    assert.equal(u.searchParams.get('client_id'), 'test-app');
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'pinterest-code'); back.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { Location: String(back) }); return res.end();
  }
  if (u.pathname === '/v5/oauth/token') {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('test-app:test-secret').toString('base64')) return send(401, { message: 'bad app' });
    return send(200, { access_token: 'pin-access', refresh_token: 'pin-refresh', expires_in: 2592000, scope: 'boards:read' });
  }
  if (u.pathname.startsWith('/img/')) return send(200, PNG, 'image/png');
  if (req.headers.authorization !== 'Bearer pin-access') return send(401, { message: 'bad token' });
  if (u.pathname === '/v5/user_account') return send(200, { username: 'demo_user', account_type: 'PERSONAL' });
  if (u.pathname === '/v5/boards') return send(200, { items: [
    { id: 'b1', name: 'Landing Pages', privacy: 'SECRET', pin_count: 2, description: 'hero sections' },
    { id: 'b2', name: 'Typography', privacy: 'PUBLIC', pin_count: 0 },
  ], bookmark: null });
  if (u.pathname === '/v5/boards/b1/pins') return send(200, { items: [pin('p1', 'Bold hero'), pin('p2', 'Split layout')], bookmark: null });
  if (u.pathname === '/v5/search/pins') return send(200, { items: [pin('p3', `Result for ${u.searchParams.get('query')}`)], bookmark: null });
  send(404, { message: 'not found' });
});

// ---------- hosted server under test ----------
let deno, BASE, MCP;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  const port = 18000 + Math.floor(Math.random() * 1000);
  BASE = `http://127.0.0.1:${port}/functions/v1/pinterest-mcp`;
  MCP = `${BASE}/mcp`;
  deno = spawn('deno', ['run', '-A', '--config', `${FN_DIR}deno.json`, `${FN_DIR}index.ts`], {
    env: { ...process.env, PORT: String(port), PMCP_STORE: 'memory', PMCP_ENC_KEY: 'test-encryption-key', PUBLIC_BASE_URL: BASE,
      PINTEREST_API: `${mockUrl}/v5`, PINTEREST_OAUTH_URL: `${mockUrl}/oauth/`, PINTEREST_CLIENT_ID: 'test-app', PINTEREST_CLIENT_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  deno.stdout.on('data', (d) => (log += d)); deno.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(BASE)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start:\n' + log);
});
after(() => { deno?.kill(); mock.close(); });

// Follow the browser redirects (authorize -> Pinterest -> callback -> client) and return the final URL.
async function followToClient(start, clientRedirect) {
  let url = String(start);
  for (let i = 0; i < 5; i++) {
    if (url.startsWith(clientRedirect)) return new URL(url);
    const r = await fetch(url, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) throw new Error(`no redirect from ${url}: ${r.status} ${await r.text()}`);
    url = new URL(loc, url).toString();
  }
  throw new Error('too many redirects');
}

class MemoryAuthProvider {
  redirectUrl = 'http://localhost:33418/callback';
  clientMetadata = { client_name: 'e2e', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  clientInformation() { return this.info; } saveClientInformation(i) { this.info = i; }
  tokens() { return this.toks; } saveTokens(t) { this.toks = t; }
  codeVerifier() { return this.verifier; } saveCodeVerifier(v) { this.verifier = v; }
  redirectToAuthorization(u) { this.authUrl = u; }
}

const provider = new MemoryAuthProvider();
let client;

test('MCP client discovers OAuth, registers, signs in via Pinterest and connects', async () => {
  const first = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
  await assert.rejects(new Client({ name: 'e2e', version: '1' }).connect(first), /Unauthorized/);
  assert.ok(provider.info?.client_id?.startsWith('pmcp_'), 'dynamic client registration happened');
  assert.ok(provider.authUrl, 'client was sent to /authorize');
  assert.equal(provider.authUrl.searchParams.get('code_challenge_method'), 'S256');

  const done = await followToClient(provider.authUrl, provider.redirectUrl);
  const code = done.searchParams.get('code');
  assert.ok(code, `got an auth code (${done})`);
  await first.finishAuth(code);
  assert.ok(provider.toks?.access_token && provider.toks?.refresh_token);

  client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider }));
});

test('hosted server exposes the read-only tools (no filesystem tool)', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_board_pins', 'list_boards', 'search_my_pins', 'view_pins']);
});

test('tools return Pinterest data', async () => {
  const boards = JSON.parse((await client.callTool({ name: 'list_boards', arguments: {} })).content[0].text);
  assert.equal(boards[0].name, 'Landing Pages');
  assert.equal(boards[0].privacy, 'SECRET');

  const pins = JSON.parse((await client.callTool({ name: 'get_board_pins', arguments: { board: 'landing pages' } })).content[0].text);
  assert.equal(pins.count, 2);
  assert.equal(pins.pins[0].note, 'love the type');

  const found = JSON.parse((await client.callTool({ name: 'search_my_pins', arguments: { query: 'serif' } })).content[0].text);
  assert.equal(found[0].title, 'Result for serif');

  const bad = await client.callTool({ name: 'get_board_pins', arguments: { board: 'nope' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /No board matches/);
});

test('view_pins returns real images', async () => {
  const r = await client.callTool({ name: 'view_pins', arguments: { board: 'Landing Pages', limit: 2 } });
  const images = r.content.filter((c) => c.type === 'image');
  assert.equal(images.length, 2);
  assert.equal(images[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(images[0].data, 'base64'), PNG);
});

test('no or bad bearer token -> 401 pointing at resource metadata', async () => {
  for (const auth of [undefined, 'Bearer not-a-real-token']) {
    const r = await fetch(MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) }, body: '{}' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
  }
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, MCP);
});

test('registration rejects redirect URIs outside the allowlist', async () => {
  for (const uri of ['https://evil.example/callback', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'javascript:alert(1)']) {
    const r = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }) });
    assert.equal(r.status, 400, uri);
    assert.equal((await r.json()).error, 'invalid_redirect_uri');
  }
  const ok = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }) });
  assert.equal(ok.status, 201);
});

// Manual flow helpers for the protocol edge cases.
async function registerClient(body = {}) {
  const r = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none', ...body }) });
  return r.json();
}
async function getCode(clientId, challenge) {
  const u = new URL(`${BASE}/authorize`);
  u.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:9/cb', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const done = await followToClient(u, 'http://127.0.0.1:9/cb');
  assert.equal(done.searchParams.get('state'), 'xyz', 'client state is round-tripped');
  return done.searchParams.get('code');
}
const tokenCall = (params, headers = {}) => fetch(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params) });

test('PKCE is enforced and auth codes are single-use', async () => {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();

  const u = new URL(`${BASE}/authorize`);
  u.search = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://127.0.0.1:9/cb', state: 's' });
  const noPkce = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location'));
  assert.equal(noPkce.searchParams.get('error'), 'invalid_request');

  const code = await getCode(client_id, challenge);
  const wrong = await tokenCall({ grant_type: 'authorization_code', code, client_id, code_verifier: pkce().verifier, redirect_uri: 'http://127.0.0.1:9/cb' });
  assert.equal((await wrong.json()).error, 'invalid_grant');
  // The failed attempt consumed the code, so even the right verifier is now refused.
  const reuse = await tokenCall({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9/cb' });
  assert.equal((await reuse.json()).error, 'invalid_grant');

  const code2 = await getCode(client_id, challenge);
  const good = await tokenCall({ grant_type: 'authorization_code', code: code2, client_id, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9/cb' });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).token_type, 'Bearer');
});

test('refresh tokens rotate and the old one stops working', async () => {
  const { client_id } = await registerClient();
  const { verifier, challenge } = pkce();
  const code = await getCode(client_id, challenge);
  const t1 = await (await tokenCall({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier })).json();
  const t2r = await tokenCall({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id });
  assert.equal(t2r.status, 200);
  const t2 = await t2r.json();
  assert.notEqual(t2.access_token, t1.access_token);
  const again = await tokenCall({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id });
  assert.equal((await again.json()).error, 'invalid_grant');
});

test('confidential clients must authenticate at the token endpoint', async () => {
  const c = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
  assert.ok(c.client_secret);
  const { verifier, challenge } = pkce();
  const code = await getCode(c.client_id, challenge);
  const noSecret = await tokenCall({ grant_type: 'authorization_code', code, client_id: c.client_id, code_verifier: verifier });
  assert.equal(noSecret.status, 401);
  const code2 = await getCode(c.client_id, challenge);
  const basic = 'Basic ' + Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
  const ok = await tokenCall({ grant_type: 'authorization_code', code: code2, code_verifier: verifier }, { Authorization: basic });
  assert.equal(ok.status, 200);
});

test('a token from one client cannot be redeemed by another', async () => {
  const a = await registerClient();
  const b = await registerClient();
  const { verifier, challenge } = pkce();
  const code = await getCode(a.client_id, challenge);
  const r = await tokenCall({ grant_type: 'authorization_code', code, client_id: b.client_id, code_verifier: verifier });
  assert.equal((await r.json()).error, 'invalid_grant');
});
