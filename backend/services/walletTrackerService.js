/**
 * walletTrackerService — save/label/group PUBLIC addresses and aggregate them
 * into one portfolio. No wallet connection, signature, key or custody: a public
 * address is all we read. Balances come from balanceService (Etherscan transfer
 * ledger, EVM) and are priced against the cached market snapshot. Unpriced tokens
 * are excluded from the total rather than estimated; non-EVM wallets return an
 * honest per-wallet error rather than a fabricated balance.
 */
import { db, getCache } from '../lib/db.js';
import { balances, priceHoldings } from './balanceService.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

export async function listTracked(userId) {
  const { data } = await db.from('tracked_wallets').select('*').eq('user_id', userId).order('created_at');
  return data || [];
}
export async function addTracked(userId, w) {
  const row = {
    user_id: userId, address: w.address, chain: w.chain || 'eth',
    label: w.label || null, kind: w.kind || 'own', portfolio_group: w.portfolio_group || null,
  };
  const { data, error } = await db.from('tracked_wallets')
    .upsert(row, { onConflict: 'user_id,address,chain' }).select().single();
  if (error) throw error;
  return data;
}
export async function removeTracked(userId, id) {
  await db.from('tracked_wallets').delete().eq('id', id).eq('user_id', userId);
  return { deleted: true };
}

export async function portfolioForUser(userId) {
  const wallets = await listTracked(userId);
  if (!wallets.length) return unavailable('ChainQuant portfolio', 'No wallets tracked yet. Add a public address to begin.');
  const snap = await getCache('markets:scored');
  const scored = snap?.payload || [];
  const positions = [], errors = [];
  for (const w of wallets) {
    const bal = await balances(w.chain, w.address);
    if (!bal.value) { errors.push({ address: w.address, chain: w.chain, reason: bal.note }); continue; }
    priceHoldings(bal.value.holdings, scored).forEach(h =>
      positions.push({ ...h, wallet: w.label || w.address, chain: w.chain, group: w.portfolio_group || null }));
  }
  const priced = positions.filter(p => p.priced);
  const total = priced.reduce((s, p) => s + (p.value_usd || 0), 0);
  return envelope({
    total_value_usd: total,
    positions: positions.sort((a, b) => (b.value_usd || 0) - (a.value_usd || 0)),
    allocation_by_token: groupSum(priced, p => (p.symbol || '').toUpperCase(), total),
    allocation_by_chain: groupSum(priced, p => p.chain, total),
    unpriced_positions: positions.length - priced.length,
    wallet_errors: errors,
  }, {
    status: STATUS.ESTIMATED, source: 'Etherscan V2 transfer ledger + CoinGecko snapshot',
    note: 'Balances reconstructed from the ERC-20 transfer log (exact for standard tokens, not for rebasing tokens). Unpriced tokens are excluded from the total rather than estimated.',
  });
}

function groupSum(items, keyFn, total) {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); m.set(k, (m.get(k) || 0) + (it.value_usd || 0)); }
  return [...m.entries()]
    .map(([k, v]) => ({ key: k, value_usd: v, pct: total ? +(v / total * 100).toFixed(2) : 0 }))
    .sort((a, b) => b.value_usd - a.value_usd);
}
