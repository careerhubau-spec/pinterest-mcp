// Pinterest API v5 client (read-only), shared by the local stdio server and the hosted HTTP server.
// Runtime-agnostic: only uses fetch, URL and btoa, so it runs unchanged on Node 18+ and Deno.

export const SCOPES = 'boards:read,boards:read_secret,pins:read,pins:read_secret,user_accounts:read';
export const PINTEREST_API = 'https://api.pinterest.com/v5';
export const PINTEREST_OAUTH = 'https://www.pinterest.com/oauth/';

/**
 * @param {{ getToken: () => Promise<string>, apiBase?: string, fetchFn?: typeof fetch }} opts
 */
export function createPinterest({ getToken, apiBase = PINTEREST_API, fetchFn = (...a) => fetch(...a) }) {
  async function api(path, query = {}) {
    const u = new URL(apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    const r = await fetchFn(u, { headers: { Authorization: `Bearer ${await getToken()}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Pinterest API ${r.status} on ${path}: ${j.message || JSON.stringify(j)}`);
    return j;
  }

  // Follows Pinterest's bookmark pagination up to `max` items.
  async function all(path, query = {}, max = 1000) {
    const items = [];
    let bookmark;
    do {
      const j = await api(path, { ...query, page_size: 100, bookmark });
      items.push(...(j.items || []));
      bookmark = j.bookmark;
    } while (bookmark && items.length < max);
    return items.slice(0, max);
  }

  // Resolve "board name" | board id | board URL to one of the user's boards.
  async function findBoard(ref) {
    const boards = await all('/boards', {}, 2000);
    const s = String(ref).trim();
    const byId = boards.find((b) => b.id === s);
    if (byId) return byId;
    const m = s.match(/pinterest\.[^/]+\/([^/]+)\/([^/?#]+)/);
    const norm = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = norm(m ? m[2] : s);
    const exact = boards.find((b) => norm(b.name) === slug);
    if (exact) return exact;
    const part = boards.filter((b) => norm(b.name).includes(slug) || slug.includes(norm(b.name)));
    if (part.length === 1) return part[0];
    throw new Error(part.length
      ? `"${ref}" matches several boards: ${part.map((b) => b.name).join(', ')}`
      : `No board matches "${ref}". Your boards: ${boards.map((b) => b.name).join(', ') || 'none'}.`);
  }

  return { api, all, findBoard };
}

/** Exchange an auth code or refresh token with Pinterest. Returns a normalised token record. */
export async function tokenExchange({ clientId, clientSecret, params, apiBase = PINTEREST_API, fetchFn = (...a) => fetch(...a) }) {
  const r = await fetchFn(`${apiBase}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${clientId}:${clientSecret}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Pinterest token error ${r.status}: ${j.message || JSON.stringify(j)}`);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || params.refresh_token,
    expires_at: Date.now() + (j.expires_in || 2592000) * 1000,
    scope: j.scope,
  };
}

/** Trim a raw Pinterest pin to the fields an agent needs (saves tokens). */
export function slim(p) {
  const im = p.media?.images || {};
  const best = im.originals || im['1200x'] || im['600x'] || Object.values(im)[0] || {};
  const thumb = im['600x'] || im['400x300'] || im['236x'] || best;
  return {
    id: p.id, title: p.title || '', description: p.description || '', note: p.note || '', link: p.link || '',
    alt: p.alt_text || '', board_id: p.board_id, section_id: p.board_section_id || null, created: p.created_at,
    image: best.url || null, thumb: thumb.url || null, width: best.width, height: best.height,
    media_type: p.media?.media_type, pin_url: `https://www.pinterest.com/pin/${p.id}/`,
  };
}
