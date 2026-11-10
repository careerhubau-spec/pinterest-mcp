#!/usr/bin/env node
// Local Pinterest MCP server (stdio). Same tools as the hosted version, plus download_board.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createPinterest, slim } from './src/pinterest.mjs';
import { registerTools } from './src/tools.mjs';
import { accessToken } from './keychain.mjs';

const pin = createPinterest({ getToken: accessToken });

async function download({ board, out_dir, limit }) {
  const b = await pin.findBoard(board);
  const dir = resolve(out_dir.replace(/^~/, homedir()));
  mkdirSync(dir, { recursive: true });
  const pins = (await pin.all(`/boards/${b.id}/pins`, {}, limit)).map(slim);
  let ok = 0;
  for (const [i, p] of pins.entries()) {
    if (!p.image) { p.error = 'no image'; continue; }
    try {
      const r = await fetch(p.image);
      if (!r.ok) throw new Error(r.status);
      const ext = (p.image.match(/\.(jpe?g|png|gif|webp)(\?|$)/i) || [, 'jpg'])[1].toLowerCase();
      p.file = `pin-${String(i + 1).padStart(2, '0')}.${ext}`;
      writeFileSync(`${dir}/${p.file}`, Buffer.from(await r.arrayBuffer()));
      ok++;
    } catch (e) { p.error = String(e.message || e); }
  }
  writeFileSync(`${dir}/pins.json`, JSON.stringify({
    source: `pinterest board ${b.name} (${b.id}, ${b.privacy})`, fetched: new Date().toISOString(),
    note: 'Reference only — not licensed for use on a site.', pins,
  }, null, 2));
  return { board: b.name, saved: ok, of: pins.length, dir };
}

const server = new McpServer({ name: 'pinterest', version: '1.1.0' });
registerTools(server, pin, { download });
await server.connect(new StdioServerTransport());
