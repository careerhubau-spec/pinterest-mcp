// Probe a deployed server with the official MCP client up to the Pinterest login step.
// Usage: node test/live-probe.mjs <mcp_url>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const MCP = process.argv[2];
const p = {
  redirectUrl: 'http://localhost:33418/callback',
  clientMetadata: { client_name: 'live-probe', redirect_uris: ['http://localhost:33418/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  clientInformation() { return this.info; }, saveClientInformation(i) { this.info = i; },
  tokens() {}, saveTokens() {}, codeVerifier() { return this.v; }, saveCodeVerifier(v) { this.v = v; },
  redirectToAuthorization(u) { this.authUrl = u; },
};
try { await new Client({ name: 'probe', version: '1' }).connect(new StreamableHTTPClientTransport(new URL(MCP), { authProvider: p })); }
catch (e) { console.log('connect ->', e.constructor.name, e.message); }
console.log('registered client:', p.info?.client_id);
console.log('authorize url   :', p.authUrl && p.authUrl.origin + p.authUrl.pathname);
if (p.authUrl) {
  const r = await fetch(p.authUrl, { redirect: 'manual' });
  console.log('authorize ->', r.status, r.headers.get('location'));
}
