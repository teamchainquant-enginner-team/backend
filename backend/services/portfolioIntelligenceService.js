/**
 * portfolioIntelligenceService — personalised intelligence from a read-only address.
 *
 * No buy/sell instructions, ever. Every insight names the data behind it so the
 * user can expand and check it.
 */
import { db } from '../lib/db.js';
import { envelope, STATUS } from '../lib/envelope.js';
import { comboRead } from './scoringService.js';

export async function portfolioIntel(holdings, scored, narrativesList) {
  // holdings: [{ symbol, amount, value_usd }] derived from a read-only address
  const held = (holdings || []).map((h) => {
    const a = scored.find((s) => (s.symbol || '').toUpperCase() === h.symbol.toUpperCase());
    return a ? { ...h, asset: a } : { ...h, asset: null };
  });

  const totalValue = held.reduce((s, h) => s + (h.value_usd || 0), 0);
  const insights = [];

  // Narrative concentration — real, computable, and the single most useful thing here.
  const byCat = {};
  held.forEach((h) => {
    if (!h.asset) return;
    const cat = h.asset.category || 'unknown';
    byCat[cat] = (byCat[cat] || 0) + (h.value_usd || 0);
  });
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  if (topCat && totalValue > 0) {
    const pct = (topCat[1] / totalValue) * 100;
    insights.push({
      headline: `Your portfolio is ${pct.toFixed(0)}% concentrated in the ${topCat[0]} narrative.`,
      severity: pct > 50 ? 'high' : pct > 30 ? 'medium' : 'low',
      evidence: { narrative: topCat[0], exposure_usd: topCat[1], total_usd: totalValue },
      source: 'CoinGecko categories + your holdings',
    });
  }

  // Risk changes on held assets
  held.filter((h) => h.asset).forEach((h) => {
    const r = h.asset.risk, o = h.asset.opportunity;
    if (r.classification === 'High' || r.classification === 'Elevated') {
      insights.push({
        headline: `${h.symbol.toUpperCase()} carries ${r.classification.toLowerCase()} measured risk (${r.score}/100).`,
        severity: r.classification === 'High' ? 'high' : 'medium',
        evidence: { drivers: r.drivers.filter((d) => d.v >= 50), unmeasured: r.unmeasured },
        interpretation: comboRead(o.score, r.score),
        source: r.data_sources.join(', '),
      });
    }
  });

  // Narrative momentum on held assets
  held.filter((h) => h.asset).forEach((h) => {
    const n = (narrativesList || []).find((x) => x.name.toLowerCase() === (h.asset.category || '').toLowerCase());
    if (n && ['Declining', 'Dormant', 'Peaking'].includes(n.lifecycle_stage)) {
      insights.push({
        headline: `${h.symbol.toUpperCase()} sits in a narrative that is ${n.lifecycle_stage.toLowerCase()}.`,
        severity: 'medium',
        evidence: { narrative: n.name, velocity_7d_pct: n.velocity_7d_pct, reason: n.lifecycle_reason },
        source: 'DefiLlama category capital flow',
      });
    }
  });

  return envelope({
    total_value_usd: totalValue,
    positions: held.length,
    narrative_exposure: byCat,
    insights,
    assets_requiring_attention: insights.filter((i) => i.severity === 'high').length,
    disclaimer: 'ChainQuant reports conditions worth reviewing. It does not tell you what to buy or sell.',
  }, {
    status: STATUS.MODEL,
    source: 'ChainQuant portfolio intelligence',
    model_version: 'chainquant_portfolio_1.0.0',
  });
}

export async function snapshot(userId, payload) {
  if (!db) return;
  await db.from('portfolio_snapshots').insert({ user_id: userId, payload });
}
