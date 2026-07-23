/**
 * entityService — resolve an address OR symbol to a ChainQuant entity (ChainQuant
 * ID) with every linked address, so wrapped/bridged/treasury/deployer addresses
 * are understood as one entity rather than unrelated tokens. Backend-only writes.
 */
import { db } from '../lib/db.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

export async function resolveEntity(query) {
  if (!db) return unavailable('Supabase', 'Database not configured.');
  const q = String(query || '').trim();
  if (!q) return unavailable('ChainQuant entity', 'Provide an address or symbol.');

  let entityId = null;
  if (/^0x[0-9a-fA-F]{40}$/.test(q) || q.length >= 32) {
    const { data } = await db.from('entity_addresses').select('entity_id').ilike('address', q).maybeSingle();
    if (data) entityId = data.entity_id;
  }
  if (!entityId) {
    const { data } = await db.from('entities').select('id').ilike('primary_symbol', q).maybeSingle();
    if (data) entityId = data.id;
  }
  if (!entityId) return unavailable('ChainQuant entity', `No ChainQuant entity is mapped for "${q}" yet. The entity graph grows as addresses are linked.`);

  const [{ data: entity }, { data: addresses }, { data: links }] = await Promise.all([
    db.from('entities').select('*').eq('id', entityId).single(),
    db.from('entity_addresses').select('network,address,role').eq('entity_id', entityId),
    db.from('entity_links').select('kind,value,meta').eq('entity_id', entityId),
  ]);
  return envelope({ ...entity, addresses: addresses || [], links: links || [] },
    { status: STATUS.LIVE, source: 'ChainQuant entity graph' });
}
