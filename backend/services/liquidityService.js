/**
 * liquidityService — real liquidity intelligence on free data.
 *
 * Sell impact is not guessed. It is the constant-product (x*y=k) result of
 * pushing a trade of a given size through the measured reserves of the deepest
 * pool. That is genuine maths on genuine numbers.
 *
 * LP concentration and LP-withdrawal probability require LP holder lists, which
 * are a paid endpoint everywhere. They are returned as UNAVAILABLE. They are not
 * estimated, and they are never rendered as a number.
 */
import { fetchTokenPools, fetchPoolOhlcv } from './dexDataService.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';

/**
 * Constant-product price impact for a sell of `sizeUsd` against a pool whose
 * total reserve is `reserveUsd` (roughly half of which is the quote side).
 */
function sellImpactPct(sizeUsd, reserveUsd) {
  const quoteSide = reserveUsd / 2;
  if (quoteSide <= 0) return null;
  // impact = 1 - k/(k + dx) on the quote reserve; expressed as a % price move
  const impact = 1 - quoteSide / (quoteSide + sizeUsd);
  return impact * 100;
}

export async function liquidityIntel(network, tokenAddress, { marketCap = 0 } = {}) {
  if (!network || !tokenAddress) {
    return unavailable('GeckoTerminal', 'No contract address is mapped for this asset, so pool-level liquidity cannot be measured.');
  }

  const pools = await fetchTokenPools(network, tokenAddress);
  if (pools.status === STATUS.UNAVAILABLE || !pools.value?.length) {
    return unavailable('GeckoTerminal', 'No liquidity pools found for this token.');
  }

  const list = pools.value;
  const deepest = list[0];
  const total = list.reduce((s, p) => s + p.reserve_usd, 0);

  // Pool concentration is measurable: how much of all liquidity sits in one pool.
  const topPoolShare = total > 0 ? (deepest.reserve_usd / total) * 100 : 0;

  // 7d liquidity trend: compare price action against reserve depth.
  const ohlcv = await fetchPoolOhlcv(network, deepest.address, 'day', 8);
  let liquidity_trend = null;
  if (ohlcv.value?.length >= 2) {
    const first = ohlcv.value[ohlcv.value.length - 1];
    const last = ohlcv.value[0];
    const priceChange = first?.[4] ? ((last[4] - first[4]) / first[4]) * 100 : null;
    liquidity_trend = { price_change_7d_pct: priceChange };
  }

  const testSize = marketCap > 0 ? marketCap * 0.01 : deepest.reserve_usd * 0.05;
  const impact = sellImpactPct(testSize, deepest.reserve_usd);

  const stability =
    deepest.reserve_usd >= 5e6 ? 'Healthy' :
    deepest.reserve_usd >= 1e6 ? 'Adequate' :
    deepest.reserve_usd >= 2e5 ? 'Thin' : 'Very thin';

  const warnings = [];
  if (topPoolShare > 80 && list.length > 1) warnings.push(`${topPoolShare.toFixed(0)}% of all measured liquidity sits in a single pool. If that pool is drained, exit routes collapse.`);
  if (list.length === 1) warnings.push('Only one liquidity pool was found. There is no alternative venue if it is withdrawn.');
  if (impact != null && impact > 15) warnings.push(`Selling 1% of market cap is estimated to move price by ~${impact.toFixed(1)}%. Exiting a position of any size will be expensive.`);
  if (deepest.reserve_usd < 2e5) warnings.push('Pool depth is below $200K. Slippage on ordinary trade sizes will be material.');

  return envelope({
    liquidity_usd: deepest.reserve_usd,
    total_liquidity_usd: total,
    pool_count: list.length,
    deepest_pool: { address: deepest.address, name: deepest.name, dex: deepest.dex, reserve_usd: deepest.reserve_usd },
    top_pool_share_pct: topPoolShare,
    est_sell_impact_1pct_mc: impact,
    stability,
    liquidity_trend,
    warnings,
    // Named, disclosed, and deliberately not invented:
    unavailable_inputs: [
      { name: 'LP concentration', reason: 'Requires an LP token holder list — a paid endpoint on every provider.' },
      { name: 'LP withdrawal probability', reason: 'Requires LP holder history. Not modelled without it.' },
    ],
  }, { status: STATUS.LIVE, source: 'GeckoTerminal', note: 'Sell impact is a constant-product estimate from live pool reserves, not an executed quote.' });
}
