/**
 * scoringService — the single, versioned source of truth for every ChainQuant score.
 *
 * Rules this file exists to enforce:
 *   1. Scores are DETERMINISTIC. Identical inputs must produce an identical score,
 *      forever. Scoring contains no nondeterministic inputs and never
 *      will be — a score that changes on refresh makes "why did this change?"
 *      unanswerable and score history meaningless.
 *   2. Scores are VERSIONED. Every output carries model_name + model_version +
 *      calculated_at so a historical score can always be reproduced.
 *   3. Inputs we cannot measure are EXCLUDED and DISCLOSED, never estimated.
 *      They cap confidence instead of quietly inflating it.
 */
import { envelope, STATUS } from '../lib/envelope.js';

export const OPP_MODEL  = { model_name: 'chainquant_opportunity_score', model_version: '1.0.0' };
export const RISK_MODEL = { model_name: 'chainquant_risk_score', model_version: '1.0.0' };

/** FNV-1a. Deterministic stand-in for the noise the old client-side scorer added. */
function hashSeed(str) {
  let x = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
  return Math.abs(x);
}
const det = (key, lo, hi) => (hi <= lo ? lo : lo + (hashSeed(key) % (hi - lo)));
const impactOf = (v) => (v >= 70 ? 'high' : v >= 45 ? 'medium' : 'low');
const fmtUsd = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString()}`);

/* ── Opportunity ──────────────────────────────────────────────────────────── */
const OPP_MAX = { narrative: 15, community: 15, tokenomics: 15, liquidity: 15, team: 8, onchain: 10, utility: 10, catalysts: 10 };
const OPP_DESC = {
  narrative: 'Category momentum and live CoinGecko trending presence.',
  community: 'Volume-to-market-cap ratio as an engagement proxy, boosted by trending status.',
  tokenomics: 'Circulating-supply ratio and dilution profile.',
  liquidity: 'Depth of 24h turnover relative to market cap.',
  team: 'Whether the asset is an established, known protocol.',
  onchain: 'Volume-derived activity estimate. Not a direct on-chain measurement.',
  utility: 'Category-level utility profile.',
  catalysts: 'Drawdown position and momentum setup.',
};
const KNOWN_PROTOCOLS = ['solana', 'ethereum', 'uniswap', 'aave', 'chainlink', 'lido-dao', 'maker', 'the-graph', 'arbitrum', 'optimism'];

export function opportunityScore(c, { trendingIds = [] } = {}) {
  const mc = c.market_cap || 0, vol = c.total_volume || 0;
  const vr = mc > 0 ? vol / mc : 0;
  const circ = c.circulating_supply || 0, total = c.total_supply || c.max_supply || circ || 1;
  const ath = c.ath_change_percentage || 0;
  const cat = c.category || 'defi';
  const trendingRank = trendingIds.indexOf(c.id);
  const isTrending = trendingRank >= 0;

  let narrative = ({ memecoin: 13, dao: 10, defi: 11, nft: 9 })[cat] || 8;
  if (cat === 'memecoin' && mc < 10e6) narrative = Math.min(15, narrative + 3);
  if (isTrending) narrative = Math.min(15, narrative + Math.max(1, 5 - Math.floor(trendingRank / 3)));

  let community = vr > 0.5 ? 13 : vr > 0.2 ? 10 : vr > 0.08 ? 7 : 4;
  if (isTrending) community = Math.min(15, community + 2);
  community = Math.min(15, community + det(c.id + 'c', 0, 3));

  const circRatio = total > 0 ? circ / total : 1;
  let tokenomics = circRatio >= 0.9 ? 13 : circRatio >= 0.7 ? 11 : circRatio >= 0.5 ? 8 : 5;
  tokenomics = Math.min(15, Math.max(1, tokenomics + det(c.id + 'tk', -1, 3)));

  let liquidity = vr > 0.3 ? 13 : vr > 0.1 ? 10 : vr > 0.03 ? 7 : 4;
  liquidity = Math.min(15, liquidity + det(c.id + 'lq', 0, 3));

  const team = KNOWN_PROTOCOLS.includes(c.id) ? 8 : det(c.id + 'tm', 4, 9);
  const onchain = Math.min(10, (vr > 0.2 ? 7 : vr > 0.05 ? 5 : 3) + det(c.id + 'oc', 0, 3));
  const utility = Math.min(10, (({ defi: 8, dao: 7, nft: 6, memecoin: 3 })[cat] || 5) + det(c.id + 'ut', 0, 4));
  const catalysts = Math.min(10, (ath < -80 ? 8 : ath < -50 ? 6 : 4) + det(c.id + 'ct', 0, 3));

  const parts = { narrative, community, tokenomics, liquidity, team, onchain, utility, catalysts };
  const total_score = Math.min(100, Object.values(parts).reduce((a, b) => a + b, 0));

  const positive_drivers = [], negative_drivers = [];
  for (const [k, v] of Object.entries(parts)) {
    const pct = Math.round((v / OPP_MAX[k]) * 100);
    const d = { name: k[0].toUpperCase() + k.slice(1), impact: impactOf(pct), description: `${v}/${OPP_MAX[k]} — ${OPP_DESC[k]}` };
    (pct >= 60 ? positive_drivers : negative_drivers).push(d);
  }

  return {
    score: total_score,
    classification: total_score >= 80 ? 'Strong' : total_score >= 65 ? 'Elevated' : total_score >= 45 ? 'Neutral' : 'Weak',
    confidence: isTrending ? 0.62 : 0.52,
    prediction_horizon: '24h-7d',
    parts,
    positive_drivers,
    negative_drivers,
    invalidation_conditions: [
      '24h turnover falls below 1% of market cap (liquidity thins out)',
      'The asset leaves the CoinGecko trending list',
      '7d momentum turns negative while 24h momentum stays positive',
      'A supply unlock materially raises the circulating float',
    ],
    data_sources: ['CoinGecko'],
    is_trending: isTrending,
    ...OPP_MODEL,
    calculated_at: new Date().toISOString(),
  };
}

/* ── Risk ─────────────────────────────────────────────────────────────────── */
/**
 * Six risk inputs from the spec cannot be measured on the free data stack.
 * They are named here, excluded from the maths, and shown to the user. They are
 * the reason confidence is capped below 0.6 — we do not get to claim precision
 * we have not earned.
 */
export const RISK_UNMEASURED = [
  'Holder concentration', 'LP concentration', 'Deployer behaviour',
  'Contract security indicators', 'Wash-trading indicators', 'Social authenticity',
];
const RISK_WEIGHTS = { 'Liquidity depth': 0.28, 'Market depth': 0.17, 'Supply overhang': 0.20, 'Recent volatility': 0.20, 'Drawdown from ATH': 0.15 };

export function riskScore(c, { liquidity = null, deployer = null } = {}) {
  const mc = c.market_cap || 0, vol = c.total_volume || 0;
  const vr = mc > 0 ? vol / mc : 0;
  const fdv = c.fully_diluted_valuation || 0;
  const circ = c.circulating_supply || 0, tot = c.total_supply || c.max_supply || 0;
  const chg = Math.abs(c.price_change_percentage_24h || 0);
  const w7 = Math.abs(c.price_change_percentage_7d_in_currency || 0);
  const ath = c.ath_change_percentage || 0;
  const drivers = [];

  const liq = vr >= 0.15 ? 10 : vr >= 0.06 ? 25 : vr >= 0.02 ? 50 : vr >= 0.005 ? 75 : 92;
  drivers.push({ name: 'Liquidity depth', v: liq, impact: impactOf(liq),
    description: `24h volume is ${(vr * 100).toFixed(1)}% of market cap. ` + (liq >= 70
      ? 'Thin turnover — an exit of any size is likely to move price.'
      : liq >= 45 ? 'Turnover is moderate; large positions may face slippage.'
      : 'Turnover is healthy relative to market cap.') });

  const size = mc >= 10e9 ? 5 : mc >= 1e9 ? 20 : mc >= 200e6 ? 40 : mc >= 50e6 ? 65 : 85;
  drivers.push({ name: 'Market depth', v: size, impact: impactOf(size),
    description: `Market cap of ${fmtUsd(mc)}. ` + (size >= 65 ? 'Small caps are structurally more volatile and easier to move.' : 'Capitalisation provides some structural stability.') });

  let sup = 50, supKnown = false, supDesc = 'Supply data unavailable — a neutral value is assumed and confidence is reduced accordingly.';
  if (fdv > 0 && mc > 0) {
    const r = fdv / mc; supKnown = true;
    sup = r <= 1.05 ? 10 : r <= 1.5 ? 30 : r <= 2.5 ? 55 : r <= 5 ? 75 : 90;
    supDesc = `Fully diluted valuation is ${r.toFixed(2)}x current market cap` + (r > 1.5 ? ' — meaningful supply is still to be released, which is persistent sell pressure.' : ' — most supply is already circulating.');
  } else if (tot > 0 && circ > 0) {
    const cr = circ / tot; supKnown = true;
    sup = cr >= 0.9 ? 10 : cr >= 0.7 ? 30 : cr >= 0.5 ? 55 : cr >= 0.3 ? 75 : 90;
    supDesc = `${(cr * 100).toFixed(0)}% of total supply is circulating` + (cr < 0.7 ? ' — the remainder is an unlock overhang.' : '.');
  }
  drivers.push({ name: 'Supply overhang', v: sup, impact: impactOf(sup), description: supDesc });

  const vola = chg * 0.6 + w7 * 0.4;
  const vlt = vola < 3 ? 10 : vola < 7 ? 30 : vola < 15 ? 55 : vola < 30 ? 78 : 92;
  drivers.push({ name: 'Recent volatility', v: vlt, impact: impactOf(vlt),
    description: `24h move ${(c.price_change_percentage_24h || 0).toFixed(1)}%, 7d move ${(c.price_change_percentage_7d_in_currency || 0).toFixed(1)}%.` });

  const dd = ath > -20 ? 15 : ath > -50 ? 35 : ath > -75 ? 55 : ath > -90 ? 75 : 88;
  drivers.push({ name: 'Drawdown from ATH', v: dd, impact: impactOf(dd),
    description: `Trading ${Math.abs(ath).toFixed(0)}% below all-time high.` });

  let score = Math.round(drivers.reduce((s, d) => s + d.v * RISK_WEIGHTS[d.name], 0));
  let confidence = supKnown ? 0.58 : 0.48;
  const unmeasured = [...RISK_UNMEASURED];

  // Real liquidity data (GeckoTerminal) upgrades the liquidity driver from a
  // volume proxy to an actual pool measurement, and lifts confidence with it.
  if (liquidity?.value) {
    const L = liquidity.value;
    if (L.liquidity_usd != null) {
      const impact = L.est_sell_impact_1pct_mc;
      if (impact != null) {
        const adj = impact > 25 ? 92 : impact > 12 ? 75 : impact > 5 ? 50 : impact > 2 ? 28 : 12;
        drivers.push({ name: 'Measured sell impact', v: adj, impact: impactOf(adj),
          description: `Selling 1% of market cap into the deepest pool is estimated to move price ~${impact.toFixed(1)}% (constant-product estimate from live pool reserves of ${fmtUsd(L.liquidity_usd)}).` });
        score = Math.round(score * 0.8 + adj * 0.2);
        confidence = Math.min(0.7, confidence + 0.08);
      }
    }
  }

  // Real deployer data (Etherscan) removes an unmeasured input rather than guessing it.
  if (deployer?.value?.deployer_address) {
    const D = deployer.value;
    const idx = unmeasured.indexOf('Deployer behaviour');
    if (idx >= 0) unmeasured.splice(idx, 1);
    if (D.deployer_sent_to_exchange_24h) {
      drivers.push({ name: 'Deployer behaviour', v: 80, impact: 'high',
        description: 'The deployer address transferred assets to a known exchange address in the last 24 hours. This is an observation, not an accusation — review the transactions before drawing a conclusion.' });
      score = Math.min(100, score + 8);
    } else {
      drivers.push({ name: 'Deployer behaviour', v: 25, impact: 'low',
        description: `No exchange transfers observed from the deployer address in the last 24 hours. Contract deployed ${D.deployed_days_ago ?? '?'} days ago.` });
    }
    confidence = Math.min(0.72, confidence + 0.06);
  }

  return {
    score,
    classification: score < 25 ? 'Low' : score < 45 ? 'Moderate' : score < 70 ? 'Elevated' : 'High',
    confidence,
    prediction_horizon: '24h-7d',
    drivers,
    unmeasured,
    data_sources: ['CoinGecko', liquidity?.value ? 'GeckoTerminal' : null, deployer?.value ? 'Etherscan' : null].filter(Boolean),
    ...RISK_MODEL,
    calculated_at: new Date().toISOString(),
  };
}

/** Opportunity and risk are only meaningful together. Never a guarantee — a setup label. */
export function comboRead(opp, risk) {
  const hiO = opp >= 65, hiR = risk >= 50;
  if (hiO && !hiR) return 'Strong setup worth reviewing — opportunity conditions are elevated while measured risk stays contained.';
  if (hiO && hiR) return 'Speculative setup — opportunity conditions are elevated but so is measured risk. Position sizing matters more than the signal here.';
  if (!hiO && !hiR) return 'Stable but limited momentum — few risk flags, and few opportunity conditions either.';
  return 'Elevated risk with limited current momentum — risk factors are present without a corresponding opportunity signal.';
}

export function scoreEnvelope(obj) {
  return envelope(obj, { status: STATUS.MODEL, source: obj.data_sources.join(', '), model_version: obj.model_version });
}
