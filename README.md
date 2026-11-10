# Pinterest MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents such as Claude read your own Pinterest boards and pins. You can turn a moodboard into usable design references inside an AI workflow.

> "Pull my *Landing Pages* board and design three directions from it." The agent reads the board, sees each pin's image, title, source link and your private notes, and works from your actual taste instead of generic defaults.

## Why I built it

I use Claude as a creative director for web design work. My reference material lives on Pinterest, often on secret boards with notes on *why* I saved a pin. I had no clean way to get it to an agent, and copying screenshots by hand lost the context. This server closes that gap. It has four focused tools, uses OAuth, and never asks for write access.

## Tools

| Tool | What it does |
|---|---|
| `list_boards` | Lists your boards (public, protected and secret) with pin counts. Optional name filter. |
| `get_board_pins` | Returns pins from one board (by name, id or URL), optionally from one section: title, description, your note, alt text, source link and full-size image URL. Pages through up to 500 pins. |
| `search_my_pins` | Keyword search across your saved pins, like "japandi", "serif" or "pricing page". |
| `download_board` | Saves a board's full-size images plus a `pins.json` manifest to a local folder, ready for moodboarding. |

Board lookup is forgiving. `"landing pages"`, `landing-pages`, a board id or a full `pinterest.com/user/board/` URL all resolve to the same board. If a name is ambiguous, you get a clear error that lists the candidates.

## Design decisions

- **Read-only by design.** It only requests `boards:read`, `boards:read_secret`, `pins:read`, `pins:read_secret` and `user_accounts:read`. The agent can't post, pin or delete anything.
- **No secrets on disk.** The app credentials and OAuth tokens are stored in the macOS Keychain (service `pinterest-mcp`), not in `.env` files or config. Nothing secret can be committed by accident.
- **Automatic token refresh.** The access token refreshes about an hour before it expires, so long agent sessions don't fail partway through.
- **OAuth with CSRF protection.** `auth.mjs` runs a short-lived local callback server on port 8085 and checks a random `state` value before it swaps the code for a token.
- **Agent-friendly output.** The raw Pinterest API responses are cut down to the fields an agent needs (`slim()`), which saves tokens. Errors come back as readable tool results the agent can act on, not crashes.
- **Small footprint.** About 250 lines across three files. The only dependencies are `@modelcontextprotocol/sdk` and `zod`.

## Architecture

```
Claude / any MCP client
        │  stdio (JSON-RPC)
        ▼
  server.mjs ── tool definitions + zod input schemas
        │
  pinterest.mjs ── Pinterest API v5 client: paging, board lookup,
        │          token refresh, Keychain storage
        ▼
  api.pinterest.com/v5          macOS Keychain
                                 (client_id, client_secret, token)
```

## Setup

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

Once it's connected, ask your agent:

- "List my Pinterest boards."
- "What's on my *Typography* board? Summarise the common style."
- "Search my pins for 'dark mode dashboard' and pick the best three for a SaaS landing page."
- "Download my *Brand Refs* board to ~/design-refs/acme so we can build a moodboard."

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the server on stdio |
| `npm run auth` | Connect a Pinterest account |
| `npm run status` | Show which account is connected |
| `npm run check` | Syntax-check all modules |

To disconnect: `security delete-generic-password -s pinterest-mcp -a token`

## Notes

- Downloaded pin images are for **reference only**. They belong to their creators and aren't licensed for reuse.
- It reads only the connected account's own boards.
- New Pinterest developer apps start in "trial" access, which is enough for personal use.

## License

MIT
