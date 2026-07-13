/**
 * narrativeService — the differentiator, and it runs entirely on free data.
 *
 * DefiLlama gives protocol-level TVL with a `category` field and a 1d/7d change.
 * Aggregating TVL by category produces REAL capital inflow and outflow per
 * narrative over time. That is narrative velocity measured in dollars, not a
 * hardcoded array — which is what the old terminal shipped.
 *
 * Smart-money participation per narrative is NOT included here. It requires the
 * ChainQuant wallet proxy index, which needs weeks of accumulated pool-trade
 * history before it means anything. Until then it is reported as unavailable
 * rather than filled in with a plausible-looking number.
 */
import { fetchProtocols } from './defiDataService.js';
import { envelope, STATUS } from '../lib/envelope.js';

export const LIFECYCLE = ['Emerging', 'Accelerating', 'Expanding', 'Crowded', 'Peaking', 'Declining', 'Dormant'];

/**
 * Lifecycle is derived, not asserted. Every stage below is a function of two
 * measured quantities: 7d capital flow and 1d capital flow. The reasoning string
 * shows the user exactly why a narrative sits where it sits.
 */
function lifecycleOf({ change7d, change1d, tvl }) {
  if (tvl < 25e6) return { stage: 'Emerging', why: 'Capital base is still small; the narrative has not yet attracted size.' };
  if (change7d > 25 && change1d > 2) return { stage: 'Accelerating', why: `Capital inflows of ${change7d.toFixed(1)}% over 7 days and still rising today.` };
  if (change7d > 8) return { stage: 'Expanding', why: `Steady 7-day capital inflow of ${change7d.toFixed(1)}%.` };
  if (change7d > 0 && change1d < -2) return { stage: 'Peaking', why: `The 7-day trend is still positive (${change7d.toFixed(1)}%) but capital started leaving today (${change1d.toFixed(1)}%).` };
  if (change7d > -3 && change7d <= 8) return { stage: 'Crowded', why: `Capital is flat over 7 days (${change7d.toFixed(1)}%) — the narrative is well-populated but no longer attracting new money.` };
  if (change7d <= -3 && change7d > -20) return { stage: 'Declining', why: `Capital outflow of ${change7d.toFixed(1)}% over 7 days.` };
  return { stage: 'Dormant', why: `Sustained capital outflow of ${change7d.toFixed(1)}% over 7 days.` };
}

export async function narratives() {
  const protos = await fetchProtocols();
  const byCat = new Map();

  for (const p of protos.value || []) {
    const cat = p.category;
    if (!cat || !p.tvl || p.tvl <= 0) continue;
    if (!byCat.has(cat)) byCat.set(cat, { name: cat, tvl: 0, tvl_prev_1d: 0, tvl_prev_7d: 0, protocols: [] });
    const c = byCat.get(cat);
    const d1 = Number(p.change_1d || 0), d7 = Number(p.change_7d || 0);
    c.tvl += p.tvl;
    c.tvl_prev_1d += p.tvl / (1 + d1 / 100);
    c.tvl_prev_7d += p.tvl / (1 + d7 / 100);
    c.protocols.push({ name: p.name, symbol: p.symbol, tvl: p.tvl, change_7d: d7, chain: p.chain });
  }

  const totalTvl = [...byCat.values()].reduce((s, c) => s + c.tvl, 0);

  const out = [...byCat.values()].map((c) => {
    const change1d = c.tvl_prev_1d > 0 ? ((c.tvl - c.tvl_prev_1d) / c.tvl_prev_1d) * 100 : 0;
    const change7d = c.tvl_prev_7d > 0 ? ((c.tvl - c.tvl_prev_7d) / c.tvl_prev_7d) * 100 : 0;
    const { stage, why } = lifecycleOf({ change7d, change1d, tvl: c.tvl });
    const leaders = c.protocols.slice().sort((a, b) => b.tvl - a.tvl).slice(0, 5);
    const emerging = c.protocols.filter((p) => p.tvl < 50e6 && p.change_7d > 20).sort((a, b) => b.change_7d - a.change_7d).slice(0, 5);
    const declining = c.protocols.filter((p) => p.change_7d < -10).sort((a, b) => a.change_7d - b.change_7d).slice(0, 5);

    return {
      name: c.name,
      tvl: c.tvl,
      capital_inflow_7d_usd: Math.max(0, c.tvl - c.tvl_prev_7d),
      capital_outflow_7d_usd: Math.max(0, c.tvl_prev_7d - c.tvl),
      velocity_7d_pct: change7d,
      velocity_1d_pct: change1d,
      market_share_pct: totalTvl > 0 ? (c.tvl / totalTvl) * 100 : 0,
      lifecycle_stage: stage,
      lifecycle_reason: why,
      risk_level: change7d < -15 ? 'Elevated' : change7d > 40 ? 'Elevated' : 'Moderate',
      leading_tokens: leaders,
      emerging_tokens: emerging,
      declining_tokens: declining,
      protocol_count: c.protocols.length,
      unavailable_inputs: [
        { name: 'Smart-money participation', reason: 'Requires the ChainQuant wallet proxy index, which needs accumulated pool-trade history. Not yet available.' },
        { name: 'Social growth', reason: 'No social API is connected. Not estimated.' },
      ],
    };
  }).sort((a, b) => b.tvl - a.tvl);

  return envelope(out, {
    status: STATUS.LIVE,
    source: 'DefiLlama',
    note: 'Narrative velocity is measured as real capital flow (TVL) per category. Lifecycle stage is derived from that flow and is a model output.',
  });
}

/** Capital rotation: which narratives gained the dollars that others lost. */
export async function rotation() {
  const n = await narratives();
  const list = n.value || [];
  const inflows = list.filter((x) => x.capital_inflow_7d_usd > 0).sort((a, b) => b.capital_inflow_7d_usd - a.capital_inflow_7d_usd).slice(0, 5);
  const outflows = list.filter((x) => x.capital_outflow_7d_usd > 0).sort((a, b) => b.capital_outflow_7d_usd - a.capital_outflow_7d_usd).slice(0, 5);
  return envelope({ into: inflows, out_of: outflows }, {
    status: STATUS.LIVE,
    source: 'DefiLlama',
    note: 'Rotation shows which categories gained and lost capital over 7 days. It does not prove the same dollars moved between them.',
  });
}
