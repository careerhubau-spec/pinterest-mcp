// MCP tool definitions, shared by both transports. The local server adds `download_board`;
// the hosted server can't write to the user's disk, so it relies on `view_pins` (images inline).
import { z } from 'zod';
import { slim } from './pinterest.mjs';

const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const wrap = (fn) => async (args) => {
  try {
    const out = await fn(args);
    return out && Array.isArray(out.content) ? out : text(out);
  } catch (e) {
    return { ...text(`Error: ${e.message}`), isError: true };
  }
};

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function boardPins(pin, { board, section, limit }) {
  const b = await pin.findBoard(board);
  let path = `/boards/${b.id}/pins`;
  if (section) {
    const secs = await pin.all(`/boards/${b.id}/sections`, {}, 200);
    const s = secs.find((x) => x.name.toLowerCase().includes(section.toLowerCase()));
    if (!s) throw new Error(`No section "${section}" on ${b.name}. Sections: ${secs.map((x) => x.name).join(', ') || 'none'}`);
    path = `/boards/${b.id}/sections/${s.id}/pins`;
  }
  return { board: b, pins: (await pin.all(path, {}, limit)).map(slim) };
}

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {ReturnType<import('./pinterest.mjs').createPinterest>} pin
 * @param {{ download?: (args: {board: string, out_dir: string, limit: number}) => Promise<object>, fetchFn?: typeof fetch }} [opts]
 */
export function registerTools(server, pin, { download, fetchFn = (...a) => fetch(...a) } = {}) {
  server.registerTool('list_boards', {
    title: 'List my Pinterest boards',
    description: 'List your own Pinterest boards (public, protected and secret) with pin counts and descriptions.',
    inputSchema: { query: z.string().optional().describe('Optional filter on board name') },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ query }) => {
    const boards = await pin.all('/boards', {}, 2000);
    return boards
      .filter((b) => !query || b.name.toLowerCase().includes(query.toLowerCase()))
      .map((b) => ({ id: b.id, name: b.name, privacy: b.privacy, pins: b.pin_count, description: b.description || '' }));
  }));

  server.registerTool('get_board_pins', {
    title: 'Read pins on a board',
    description: 'Get the pins on one of my boards (by name, id or board URL): title, description, my pin note, alt text, source link and full-size image URL. Use for design inspiration.',
    inputSchema: {
      board: z.string().describe('Board name, id or URL'),
      limit: z.number().int().min(1).max(500).default(60),
      section: z.string().optional().describe('Optional section name'),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ board, limit, section }) => {
    const { board: b, pins } = await boardPins(pin, { board, section, limit });
    return { board: { id: b.id, name: b.name, privacy: b.privacy, description: b.description || '' }, count: pins.length, pins };
  }));

  server.registerTool('search_my_pins', {
    title: 'Search my pins',
    description: "Search your own saved pins by keyword (e.g. 'serif', 'japandi', 'landing page').",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(250).default(40) },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ query, limit }) => (await pin.all('/search/pins', { query }, limit)).map(slim)));

  server.registerTool('view_pins', {
    title: 'Look at pin images',
    description: 'Return the actual images (not just URLs) for pins from a board or a keyword search, so you can see and critique the visual style. Use a small limit; images are reference only.',
    inputSchema: {
      board: z.string().optional().describe('Board name, id or URL'),
      query: z.string().optional().describe('Keyword search across my pins (used if no board)'),
      section: z.string().optional(),
      limit: z.number().int().min(1).max(12).default(6),
    },
    annotations: { readOnlyHint: true },
  }, wrap(async ({ board, query, section, limit }) => {
    if (!board && !query) throw new Error('Pass a board or a query.');
    const pins = board
      ? (await boardPins(pin, { board, section, limit })).pins
      : (await pin.all('/search/pins', { query }, limit)).map(slim);
    const content = [];
    const index = [];
    for (const [i, p] of pins.entries()) {
      const src = p.thumb || p.image;
      if (!src) continue;
      try {
        const r = await fetchFn(src);
        const mimeType = (r.headers.get('content-type') || '').split(';')[0];
        if (!r.ok || !mimeType.startsWith('image/')) throw new Error(String(r.status));
        content.push({ type: 'image', data: toBase64(await r.arrayBuffer()), mimeType });
        index.push({ n: i + 1, title: p.title, note: p.note, link: p.link, pin_url: p.pin_url });
      } catch (e) {
        index.push({ n: i + 1, title: p.title, pin_url: p.pin_url, error: `image unavailable (${e.message})` });
      }
    }
    content.unshift({ type: 'text', text: JSON.stringify({ shown: content.length, of: pins.length, pins: index, note: 'Reference only; images belong to their creators.' }, null, 2) });
    return { content };
  }));

  if (download) {
    server.registerTool('download_board', {
      title: 'Download a board as design references',
      description: "Save a board's pin images (full size) + pins.json into a local folder for use as design references (moodboards, art direction). Reference only — never put pin images on a page.",
      inputSchema: {
        board: z.string(),
        out_dir: z.string().describe('Folder, e.g. ~/design-refs/<project>'),
        limit: z.number().int().min(1).max(200).default(40),
      },
    }, wrap(download));
  }
}
