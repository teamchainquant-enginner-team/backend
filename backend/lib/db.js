import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

/**
 * The service key never leaves this process. The frontend talks to this API,
 * not to Supabase directly, so no key is ever shipped to a browser.
 */
export const db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
export const dbReady = () => Boolean(db);

export async function putCache(key, payload, source) {
  if (!db) return;
  await db.from('cache_snapshots').upsert(
    { key, payload, source, fetched_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
}

export async function getCache(key) {
  if (!db) return null;
  const { data, error } = await db.from('cache_snapshots').select('*').eq('key', key).maybeSingle();
  return error ? null : data;
}
