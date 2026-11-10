// Small WebCrypto helpers: random tokens, SHA-256 hashing (tokens are stored hashed),
// and AES-256-GCM for the Pinterest tokens we hold on the user's behalf.
const te = new TextEncoder();
const td = new TextDecoder();

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** base64url(SHA-256(s)) — also exactly the PKCE S256 transform. */
export async function sha256(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', te.encode(s)));
}

let keyPromise: Promise<CryptoKey> | undefined;
export function initEncryption(secret: string) {
  if (!secret) throw new Error('No encryption secret: set PMCP_ENC_KEY');
  keyPromise = (async () => {
    const ikm = await crypto.subtle.importKey('raw', te.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: te.encode('pinterest-mcp'), info: te.encode('grant-tokens-v1') },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  })();
}

export async function encrypt(obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyPromise!, te.encode(JSON.stringify(obj)));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function decrypt<T = any>(blob: string): Promise<T> {
  const [iv, ct] = blob.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, await keyPromise!, unb64url(ct));
  return JSON.parse(td.decode(pt));
}
