// Pinterest API v5 client (read-only) + macOS Keychain storage. Secrets never touch disk.
import { execFileSync } from 'node:child_process';
const SERVICE = 'pinterest-mcp';
export const API = 'https://api.pinterest.com/v5';
export const SCOPES = 'boards:read,boards:read_secret,pins:read,pins:read_secret,user_accounts:read';
export const REDIRECT = 'http://localhost:8085/callback';

export function kcGet(account) {
  try { return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
export function kcSet(account, value) {
  execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value], { stdio: 'ignore' });
}

const basic = () => 'Basic ' + Buffer.from(`${kcGet('client_id')}:${kcGet('client_secret')}`).toString('base64');
export async function tokenRequest(params) {
  const r = await fetch(`${API}/oauth/token`, { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Pinterest token error ${r.status}: ${j.message || JSON.stringify(j)}`);
  const now = Date.now();
  const prev = JSON.parse(kcGet('token') || '{}');
  const tok = { access_token: j.access_token, refresh_token: j.refresh_token || prev.refresh_token,
    expires_at: now + (j.expires_in || 2592000) * 1000, scope: j.scope };
  kcSet('token', JSON.stringify(tok));
  return tok;
}
async function accessToken() {
  const tok = JSON.parse(kcGet('token') || 'null');
  if (!tok) throw new Error('Not connected to Pinterest yet. Run: npm run auth (in the pinterest-mcp folder)');
  if (Date.now() < tok.expires_at - 3600_000) return tok.access_token;
  return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })).access_token;
}
export async function api(path, query = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Pinterest API ${r.status} on ${path}: ${j.message || JSON.stringify(j)}`);
  return j;
}
export async function all(path, query = {}, max = 1000) {
  const items = []; let bookmark;
  do {
    const j = await api(path, { ...query, page_size: 100, bookmark });
    items.push(...(j.items || [])); bookmark = j.bookmark;
  } while (bookmark && items.length < max);
  return items.slice(0, max);
}

export const slim = (p) => {
  const im = p.media?.images || {};
  const best = im.originals || im['1200x'] || im['600x'] || Object.values(im)[0] || {};
  return { id: p.id, title: p.title || '', description: p.description || '', note: p.note || '', link: p.link || '',
    alt: p.alt_text || '', board_id: p.board_id, section_id: p.board_section_id || null, created: p.created_at,
    image: best.url || null, width: best.width, height: best.height, media_type: p.media?.media_type,
    pin_url: `https://www.pinterest.com/pin/${p.id}/` };
};

// Resolve "board name" | board id | board URL to a board object.
export async function findBoard(ref) {
  const boards = await all('/boards', {}, 2000);
  const s = String(ref).trim();
  const byId = boards.find(b => b.id === s); if (byId) return byId;
  const m = s.match(/pinterest\.[^/]+\/([^/]+)\/([^/?#]+)/);
  const slug = (m ? m[2] : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const norm = n => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const exact = boards.find(b => norm(b.name) === slug); if (exact) return exact;
  const part = boards.filter(b => norm(b.name).includes(slug) || slug.includes(norm(b.name)));
  if (part.length === 1) return part[0];
  throw new Error(part.length ? `"${ref}" matches several boards: ${part.map(b => b.name).join(', ')}` : `No board of yours matches "${ref}". Your boards: ${boards.map(b => b.name).join(', ')}. (Other people's boards: use the public-link fetcher.)`);
}
