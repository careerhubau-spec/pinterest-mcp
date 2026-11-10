// Tiny key-value store with TTLs. Postgres (table public.pmcp_kv) in production,
// in-memory for local tests. `take` is an atomic read-and-delete, used for single-use codes.
export interface Store {
  put(ns: string, key: string, value: unknown, ttlSec?: number): Promise<void>;
  get<T = any>(ns: string, key: string): Promise<T | null>;
  take<T = any>(ns: string, key: string): Promise<T | null>;
  del(ns: string, key: string): Promise<void>;
  sweep(): Promise<void>;
}

const live = (exp: string | number | null | undefined) => exp == null || new Date(exp).getTime() > Date.now();

export function memoryStore(): Store {
  const m = new Map<string, { value: unknown; exp: number | null }>();
  const k = (ns: string, key: string) => `${ns}\u0000${key}`;
  return {
    async put(ns, key, value, ttl) { m.set(k(ns, key), { value: structuredClone(value), exp: ttl ? Date.now() + ttl * 1000 : null }); },
    async get(ns, key) { const r = m.get(k(ns, key)); return r && live(r.exp) ? structuredClone(r.value) as any : null; },
    async take(ns, key) { const r = m.get(k(ns, key)); m.delete(k(ns, key)); return r && live(r.exp) ? r.value as any : null; },
    async del(ns, key) { m.delete(k(ns, key)); },
    async sweep() { for (const [key, r] of m) if (!live(r.exp)) m.delete(key); },
  };
}

export async function supabaseStore(url: string, serviceKey: string): Promise<Store> {
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const t = () => db.from('pmcp_kv');
  const fail = (op: string, error: { message: string } | null) => { if (error) throw new Error(`store.${op}: ${error.message}`); };
  return {
    async put(ns, key, value, ttl) {
      const { error } = await t().upsert({
        ns, key, value, expires_at: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null, updated_at: new Date().toISOString(),
      });
      fail('put', error);
    },
    async get(ns, key) {
      const { data, error } = await t().select('value, expires_at').eq('ns', ns).eq('key', key).maybeSingle();
      fail('get', error);
      return data && live(data.expires_at) ? data.value : null;
    },
    async take(ns, key) {
      const { data, error } = await t().delete().eq('ns', ns).eq('key', key).select('value, expires_at');
      fail('take', error);
      const row = data?.[0];
      return row && live(row.expires_at) ? row.value : null;
    },
    async del(ns, key) { const { error } = await t().delete().eq('ns', ns).eq('key', key); fail('del', error); },
    async sweep() { const { error } = await t().delete().lt('expires_at', new Date().toISOString()); fail('sweep', error); },
  };
}
