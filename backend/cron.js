/**
 * cron worker — the only process allowed to touch external providers.
 *
 * Every 3 minutes: pull markets, score them deterministically, write the snapshot
 * and the score history, evaluate alerts.
 * Every 30 minutes: rebuild narratives from DefiLlama category capital flow.
 * Every 15 minutes: observe pool trades to accumulate the wallet proxy index.
 *
 * Total external calls sit well inside the free tiers, and they do not grow with
 * the number of users.
 */
import cron from 'node-cron';
import { fetchMarkets, fetchTrending } from '../services/marketDataService.js';
import { opportunityScore, riskScore } from '../services/scoringService.js';
import { narratives } from '../services/narrativeService.js';
import { evaluateAlerts } from '../services/alertService.js';
import { observePool } from '../services/walletIntelligenceService.js';
import { fetchTrendingPools } from '../services/dexDataService.js';
import { putCache, db } from '../lib/db.js';
import { fetchCryptoNews } from '../services/newsService.js';

const TRACKED = [
  'bitcoin','ethereum','solana','uniswap','aave','maker','chainlink','lido-dao','the-graph',
  'arbitrum','optimism','raydium','jupiter-exchange-solana','pyth-network','bonk','dogwifcoin',
  'pepe','shiba-inu','floki','dogecoin','render-token','fetch-ai','ondo-finance','celestia','injective-protocol',
];
const CATEGORY = { bonk: 'memecoin', dogwifcoin: 'memecoin', pepe: 'memecoin', 'shiba-inu': 'memecoin', floki: 'memecoin', dogecoin: 'memecoin' };

async function refreshMarkets() {
  const [markets, trending] = await Promise.all([fetchMarkets(TRACKED), fetchTrending()]);
  const trendingIds = trending.value || [];

  const scored = (markets.value || []).map((c) => {
    const withCat = { ...c, category: CATEGORY[c.id] || 'defi' };
    const opportunity = opportunityScore(withCat, { trendingIds });
    const risk = riskScore(withCat);
    return { ...withCat, opportunity, risk };
  });

  await putCache('markets:scored', scored, 'CoinGecko');

  // Score history is what makes "why did this change?" answerable at all.
  if (db && scored.length) {
    await db.from('score_history').insert(scored.map((a) => ({
      asset_id: a.id,
      opportunity_score: a.opportunity.score,
      risk_score: a.risk.score,
      opportunity_drivers: a.opportunity.positive_drivers,
      risk_drivers: a.risk.drivers,
      model_version: a.opportunity.model_version,
      calculated_at: a.opportunity.calculated_at,
    })));
  }

  const fired = await evaluateAlerts(scored);
  console.log(`[cron] markets: ${scored.length} scored, ${fired} alert(s) fired`);
}

async function refreshNarratives() {
  const n = await narratives();
  await putCache('narratives', n.value, 'DefiLlama');
  console.log(`[cron] narratives: ${n.value.length} categories`);
}

async function refreshNews() {
  const news = await fetchCryptoNews();
  if (news.value) await putCache('news:crypto', news.value, news.source);
  console.log(`[cron] news: ${news.value?.length || 0} verified headline(s) (${news.status})`);
}

/** Accumulate wallet observations. The index is worthless until this has run for weeks. */
async function observeWallets() {
  for (const network of ['eth', 'solana', 'base']) {
    const pools = await fetchTrendingPools(network);
    for (const p of (pools.value || []).slice(0, 5)) {
      const addr = p.attributes?.address;
      const name = p.attributes?.name;
      if (addr) await observePool(network, addr, name);
    }
  }
  console.log('[cron] wallet observations recorded');
}

async function runAll() {
  await refreshMarkets().catch((e) => console.error('[cron] markets failed', e.message));
  await refreshNarratives().catch((e) => console.error('[cron] narratives failed', e.message));
  await refreshNews().catch((e) => console.error('[cron] news failed', e.message));
  await observeWallets().catch((e) => console.error('[cron] wallets failed', e.message));
}

if (process.argv.includes('--once')) {
  runAll().then(() => process.exit(0));
} else {
  cron.schedule('*/3 * * * *', () => refreshMarkets().catch((e) => console.error(e.message)));
  cron.schedule('*/30 * * * *', () => refreshNarratives().catch((e) => console.error(e.message)));
  cron.schedule('*/30 * * * *', () => refreshNews().catch((e) => console.error(e.message)));
  cron.schedule('*/15 * * * *', () => observeWallets().catch((e) => console.error(e.message)));
  runAll();
  console.log('[cron] scheduled');
}
