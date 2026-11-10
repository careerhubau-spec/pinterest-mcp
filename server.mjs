#!/usr/bin/env node
// Pinterest MCP (stdio, read-only): list boards, read pins (incl. secret boards + notes), search, download for design refs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { api, all, slim, findBoard } from './pinterest.mjs';

const server = new McpServer({ name: 'pinterest', version: '1.0.0' });
const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const wrap = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return { ...text(`Error: ${e.message}`), isError: true }; } };

server.registerTool('list_boards', {
  title: 'List my Pinterest boards',
  description: "List your own Pinterest boards (public, protected and secret) with pin counts and descriptions.",
  inputSchema: { query: z.string().optional().describe('Optional filter on board name') },
}, wrap(async ({ query }) => {
  const boards = await all('/boards', {}, 2000);
  return boards.filter(b => !query || b.name.toLowerCase().includes(query.toLowerCase()))
    .map(b => ({ id: b.id, name: b.name, privacy: b.privacy, pins: b.pin_count, description: b.description || '' }));
}));

server.registerTool('get_board_pins', {
  title: 'Read pins on a board',
  description: 'Get the pins on one of my boards (by name, id or board URL): title, description, my pin note, alt text, source link and full-size image URL. Use for design inspiration.',
  inputSchema: { board: z.string().describe('Board name, id or URL'), limit: z.number().int().min(1).max(500).default(60), section: z.string().optional().describe('Optional section name') },
}, wrap(async ({ board, limit, section }) => {
  const b = await findBoard(board);
  let path = `/boards/${b.id}/pins`;
  if (section) {
    const secs = await all(`/boards/${b.id}/sections`, {}, 200);
    const s = secs.find(x => x.name.toLowerCase().includes(section.toLowerCase()));
    if (!s) throw new Error(`No section "${section}" on ${b.name}. Sections: ${secs.map(x => x.name).join(', ') || 'none'}`);
    path = `/boards/${b.id}/sections/${s.id}/pins`;
  }
  const pins = (await all(path, {}, limit)).map(slim);
  return { board: { id: b.id, name: b.name, privacy: b.privacy, description: b.description || '' }, count: pins.length, pins };
}));

server.registerTool('search_my_pins', {
  title: 'Search my pins',
  description: "Search your own saved pins by keyword (e.g. 'serif', 'japandi', 'landing page').",
  inputSchema: { query: z.string(), limit: z.number().int().min(1).max(250).default(40) },
}, wrap(async ({ query, limit }) => (await all('/search/pins', { query }, limit)).map(slim)));

server.registerTool('download_board', {
  title: 'Download a board as design references',
  description: 'Save a board\'s pin images (full size) + pins.json into a local folder for use as design references (moodboards, art direction). Reference only — never put pin images on a page.',
  inputSchema: { board: z.string(), out_dir: z.string().describe('Folder, e.g. ~/design-refs/<project>'), limit: z.number().int().min(1).max(200).default(40) },
}, wrap(async ({ board, out_dir, limit }) => {
  const b = await findBoard(board);
  const dir = resolve(out_dir.replace(/^~/, homedir()));
  mkdirSync(dir, { recursive: true });
  const pins = (await all(`/boards/${b.id}/pins`, {}, limit)).map(slim);
  let ok = 0;
  for (const [i, p] of pins.entries()) {
    if (!p.image) { p.error = 'no image'; continue; }
    try {
      const r = await fetch(p.image); if (!r.ok) throw new Error(r.status);
      const ext = (p.image.match(/\.(jpe?g|png|gif|webp)(\?|$)/i) || [, 'jpg'])[1].toLowerCase();
      p.file = `pin-${String(i + 1).padStart(2, '0')}.${ext}`;
      writeFileSync(`${dir}/${p.file}`, Buffer.from(await r.arrayBuffer())); ok++;
    } catch (e) { p.error = String(e.message || e); }
  }
  writeFileSync(`${dir}/pins.json`, JSON.stringify({ source: `pinterest board ${b.name} (${b.id}, ${b.privacy})`, fetched: new Date().toISOString(), note: 'Reference only — not licensed for use on a site.', pins }, null, 2));
  return { board: b.name, saved: ok, of: pins.length, dir };
}));

await server.connect(new StdioServerTransport());
