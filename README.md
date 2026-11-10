# Pinterest MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents such as Claude read your own Pinterest boards and pins. You can turn a moodboard into usable design references inside an AI workflow.

It runs two ways from one shared codebase:

- **Hosted**, as a Supabase Edge Function with its own OAuth 2.1 server. You add it as a custom connector in **claude.ai** (web, desktop or mobile).
- **Local**, as a stdio server for Claude Code or Claude Desktop, with credentials in the macOS Keychain.

> "Pull my *Landing Pages* board and design three directions from it." The agent reads the board, sees each pin's image, title, source link and your private notes, and works from your actual taste instead of generic defaults.

## Why I built it

I use Claude as a creative director for web design work. My reference material lives on Pinterest, often on secret boards with notes on *why* I saved a pin. I had no clean way to get it to an agent, and copying screenshots by hand lost the context. This server closes that gap. It has four focused tools, uses OAuth, and never asks for write access.

## Tools

| Tool | What it does |
|---|---|
| `list_boards` | Lists your boards (public, protected and secret) with pin counts. Optional name filter. |
| `get_board_pins` | Returns pins from one board (by name, id or URL), optionally from one section: title, description, your note, alt text, source link and full-size image URL. Pages through up to 500 pins. |
| `search_my_pins` | Keyword search across your saved pins, like "japandi", "serif" or "pricing page". |
| `view_pins` | Returns the **actual images** (base64) for pins from a board or a search, so the model can see and critique the visual style, not just read URLs. |
| `download_board` | *(Local only.)* Saves a board's full-size images plus a `pins.json` manifest to a local folder, ready for moodboarding. |

Board lookup is forgiving. `"landing pages"`, `landing-pages`, a board id or a full `pinterest.com/user/board/` URL all resolve to the same board. If a name is ambiguous, you get a clear error that lists the candidates.

## Hosted version: how claude.ai connects

claude.ai can only talk to MCP servers on the internet, and it signs users in with OAuth. Pinterest's own OAuth doesn't support what MCP clients expect (discovery metadata, dynamic client registration, PKCE). So the Edge Function is its **own authorization server** and delegates the actual login to Pinterest:

```
claude.ai                       pinterest-mcp (Edge Function)              Pinterest
   │ POST /mcp (no token) ─────────▶ 401 + WWW-Authenticate: resource_metadata
   │ GET  /.well-known/oauth-protected-resource  ─▶ "my auth server is BASE"
   │ GET  BASE/.well-known/openid-configuration  ─▶ endpoints, S256 only
   │ POST /register (DCR) ─────────▶ client_id  (redirect URI must be allowlisted)
   │ GET  /authorize + PKCE ───────▶ 302 ─────────────────────────────────▶ user clicks Allow
   │                                 GET /callback ◀── code ────────────────┘
   │                                 swap code for Pinterest tokens, encrypt, store
   │ ◀── 302 redirect_uri?code=…  (our code, single-use, 5 min)
   │ POST /token + code_verifier ──▶ access (1 h) + refresh (30 d, rotating)
   │ POST /mcp  Bearer … ──────────▶ tools ── Pinterest API (refreshed as needed) ─▶
```

- **The client never sees Pinterest credentials.** It holds only this server's tokens. The Pinterest tokens are AES-256-GCM encrypted at rest (HKDF-derived key).
- **Tokens are stored hashed** (SHA-256). A database leak exposes no usable tokens.
- **PKCE S256 is mandatory.** Codes are single-use and atomic (`DELETE … RETURNING`). Refresh tokens rotate, and a replayed token is rejected.
- **Open registration, closed redirects.** Anyone can register a client, but only claude.ai/claude.com callbacks and loopback URLs are accepted. That closes the usual "malicious client phishes a consent" hole without a consent page.
- **Stateless MCP.** Each request builds a fresh server over Streamable HTTP (JSON responses), so it scales to zero on serverless.
- **Path-based issuer.** Supabase functions live under `/functions/v1/<name>`, so root `/.well-known` URLs aren't available. The server publishes `openid-configuration` under its own path, which MCP clients try as a discovery fallback.

The state lives in one table (`pmcp_kv`: namespace, key, JSON value, expiry), with RLS on and access for the service role only.

## Design decisions

- **Read-only by design.** It only requests `boards:read`, `boards:read_secret`, `pins:read`, `pins:read_secret` and `user_accounts:read`. The agent can't post, pin or delete anything.
- **No secrets on disk (local).** The app credentials and OAuth tokens are stored in the macOS Keychain (service `pinterest-mcp`), not in `.env` files or config. Nothing secret can be committed by accident.
- **Automatic token refresh.** The access token refreshes about an hour before it expires, so long agent sessions don't fail partway through.
- **OAuth with CSRF protection.** `auth.mjs` runs a short-lived local callback server on port 8085 and checks a random `state` value before it swaps the code for a token.
- **Agent-friendly output.** The raw Pinterest API responses are cut down to the fields an agent needs (`slim()`), which saves tokens. Errors come back as readable tool results the agent can act on, not crashes.
- **Small footprint.** About 250 lines across three files. The only dependencies are `@modelcontextprotocol/sdk` and `zod`.

## Code layout

```
src/
  pinterest.mjs        Pinterest API v5 client: paging, board lookup, token exchange (Node + Deno)
  tools.mjs            MCP tool definitions + zod schemas, shared by both transports
server.mjs             local stdio server (+ download_board)
keychain.mjs, auth.mjs local credential storage + one-time OAuth sign-in
supabase/
  functions/pinterest-mcp/
    index.ts           hosted server: OAuth 2.1 AS + Streamable HTTP MCP endpoint
    store.ts           KV store (Postgres in prod, in-memory for tests)
    crypto.ts          token hashing, PKCE, AES-GCM
    shared -> ../../../src
  migrations/          pmcp_kv table
test/
  e2e.test.mjs         full OAuth + MCP flow against a mock Pinterest
  live-probe.mjs       checks a deployed URL up to the Pinterest login
```

## Tests

`npm test` starts the real Edge Function under Deno, a mock Pinterest API, and the **official MCP TypeScript client**. The client runs its own discovery, registration and PKCE flow. The suite covers:

- end-to-end sign-in, tool listing and every tool call, including real image bytes from `view_pins`
- 401s that point at resource metadata, for missing and invalid tokens
- redirect-URI allowlist, including look-alike hosts (`claude.ai.evil.example`)
- PKCE enforcement, single-use codes, cross-client code theft
- refresh-token rotation and replay rejection
- confidential-client authentication at the token endpoint

## Setup: hosted (claude.ai)

1. Create a Pinterest app at [developers.pinterest.com/apps](https://developers.pinterest.com/apps/) and add the redirect URI `https://<project>.supabase.co/functions/v1/pinterest-mcp/callback`.
2. Deploy:
   ```sh
   supabase db push                                    # creates pmcp_kv
   supabase secrets set PINTEREST_CLIENT_ID=… PINTEREST_CLIENT_SECRET=… PMCP_ENC_KEY=$(openssl rand -base64 32)
   supabase functions deploy pinterest-mcp --no-verify-jwt
   ```
3. In claude.ai, go to **Settings → Connectors → Add custom connector** and paste `https://<project>.supabase.co/functions/v1/pinterest-mcp/mcp`. Click Connect, approve on Pinterest, and you're done.

Check a deployment without a browser: `node test/live-probe.mjs <mcp-url>`.

## Setup: local (Claude Code / Claude Desktop)

Requirements: macOS (for Keychain), Node 18+, and a Pinterest account.

```sh
git clone https://github.com/careerhubau-spec/pinterest-mcp.git
cd pinterest-mcp
npm install
```

1. Create an app at [developers.pinterest.com/apps](https://developers.pinterest.com/apps/) and add the redirect URI `http://localhost:8085/callback`.
2. Connect your account. A browser opens; approve read-only access:
   ```sh
   node auth.mjs --client-id <APP_ID> --client-secret <APP_SECRET>
   npm run status   # → connected as <username>
   ```
3. Register the server with your MCP client. For Claude Code:
   ```sh
   claude mcp add pinterest -- node /absolute/path/to/pinterest-mcp/server.mjs
   ```
   For Claude Desktop, add this to `claude_desktop_config.json`:
   ```json
   { "mcpServers": { "pinterest": { "command": "node", "args": ["/absolute/path/to/pinterest-mcp/server.mjs"] } } }
   ```

## Try it

Once it's connected, ask Claude:

- "List my Pinterest boards."
- "What's on my *Typography* board? Summarise the common style."
- "Search my pins for 'dark mode dashboard', look at the images, and pick the best three for a SaaS landing page."
- "Download my *Brand Refs* board to ~/design-refs/acme so we can build a moodboard."

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the server on stdio |
| `npm run auth` | Connect a Pinterest account |
| `npm run status` | Show which account is connected |
| `npm test` | End-to-end OAuth + MCP test suite (needs Deno) |
| `npm run check` | Syntax-check the Node modules and type-check the Edge Function |

To disconnect: `security delete-generic-password -s pinterest-mcp -a token`

## Notes

- Downloaded pin images are for **reference only**. They belong to their creators and aren't licensed for reuse.
- It reads only the connected account's own boards.
- New Pinterest developer apps start in "trial" access, which is enough for personal use.

## License

MIT
