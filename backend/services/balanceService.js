/**
 * balanceService — real portfolio balances from a read-only address, on free data.
 *
 * Etherscan's `addresstokenbalance` endpoint is PRO-only, so we reconstruct token
 * balances from the free `tokentx` transfer log: for each contract, sum transfers
 * in and subtract transfers out. For standard ERC-20s this is exact, not an
 * estimate — the transfer log IS the ledger.
 *
 * It is honestly labelled ESTIMATED rather than LIVE because it is not exact for
 * rebasing tokens (stETH, AMPL) or for tokens whose balance changes without a
 * Transfer event. We say that, rather than quietly presenting a wrong number as
 * a live one.
 *
 * The old Portfolio tab was genAllocations() / genTrades() / genLeaderboard():
 * three Math.random() calls wearing a suit. This replaces them.
 */
import { get } from '../lib/http.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

const KEY = process.env.ETHERSCAN_API_KEY || '';
const BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_IDS = { eth: 1, base: 8453, arbitrum: 42161, bsc: 56, polygon: 137 };
const NATIVE = { eth: 'ETH', base: 'ETH', arbitrum: 'ETH', bsc: 'BNB', polygon: 'MATIC' };

const isEvm = (a) => /^0x[a-fA-F0-9]{40}$/.test(a);

export async function balances(chain, address) {
  if (!isEvm(address)) {
    return unavailable('ChainQuant', 'Solana balance reconstruction is not implemented. Only EVM addresses are supported today, and no figure is shown for anything else.');
  }
  if (!KEY) return unavailable('Etherscan', 'ETHERSCAN_API_KEY is not set, so balances cannot be read.');
  const chainid = CHAIN_IDS[chain];
  if (!chainid) return unavailable('Etherscan', `Chain "${chain}" is not supported.`);

  try {
    const [nativeRes, transfers] = await Promise.all([
      get('etherscan', `${BASE}?chainid=${chainid}&module=account&action=balance&address=${address}&tag=latest&apikey=${KEY}`),
      get('etherscan', `${BASE}?chainid=${chainid}&module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc&apikey=${KEY}`),
    ]);

    const holdings = [];
    const nativeWei = BigInt(nativeRes?.result || '0');
    if (nativeWei > 0n) {
      holdings.push({
        symbol: NATIVE[chain], contract: null,
        amount: Number(nativeWei) / 1e18, decimals: 18, kind: 'native',
      });
    }

    // Reconstruct ERC-20 balances from the transfer ledger.
    const byContract = new Map();
    const me = address.toLowerCase();
    for (const t of Array.isArray(transfers?.result) ? transfers.result : []) {
      const c = t.contractAddress.toLowerCase();
      if (!byContract.has(c)) {
        byContract.set(c, { symbol: t.tokenSymbol, contract: c, decimals: Number(t.tokenDecimal || 18), raw: 0n, kind: 'erc20' });
      }
      const h = byContract.get(c);
      const v = BigInt(t.value || '0');
      if (t.to?.toLowerCase() === me) h.raw += v;
      if (t.from?.toLowerCase() === me) h.raw -= v;
    }

    for (const h of byContract.values()) {
      if (h.raw <= 0n) continue; // fully exited positions are not holdings
      const amount = Number(h.raw) / 10 ** h.decimals;
      if (amount < 1e-9) continue; // dust
      holdings.push({ symbol: h.symbol, contract: h.contract, amount, decimals: h.decimals, kind: 'erc20' });
    }

    return envelope({ chain, address, holdings, position_count: holdings.length }, {
      status: STATUS.ESTIMATED,
      source: 'Etherscan V2 transfer ledger',
      note: 'Balances are reconstructed from the ERC-20 transfer log. Exact for standard tokens; not exact for rebasing tokens such as stETH, whose balance changes without a Transfer event.',
    });
  } catch {
    return unavailable('Etherscan', 'Balances could not be read for this address.');
  }
}

/** Price the holdings against the cached market snapshot. Unpriced tokens stay unpriced. */
export function priceHoldings(holdings, scored) {
  const bySymbol = new Map((scored || []).map((a) => [(a.symbol || '').toUpperCase(), a]));
  return holdings.map((h) => {
    const a = bySymbol.get((h.symbol || '').toUpperCase());
    if (!a?.current_price) {
      return { ...h, price_usd: null, value_usd: null, priced: false, asset_id: null };
    }
    return {
      ...h,
      price_usd: a.current_price,
      value_usd: h.amount * a.current_price,
      priced: true,
      asset_id: a.id,
      opportunity: a.opportunity?.score ?? null,
      risk: a.risk?.classification ?? null,
      category: a.category,
    };
  });
}
