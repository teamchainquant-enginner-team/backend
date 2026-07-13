/**
 * deployerService — Etherscan V2 (free key, one key covers ETH / Base / Arbitrum / BNB).
 *
 * What we can prove on free data: who deployed the contract, when, and whether
 * that address has since moved funds to a known exchange deposit address.
 *
 * Language rule: we report observations, never verdicts. A deployer moving funds
 * to an exchange is a fact worth surfacing. "Rug" and "scam" are conclusions we
 * are not entitled to draw from this data, and we do not draw them.
 */
import { get } from '../lib/http.js';
import { envelope, unavailable, STATUS } from '../lib/envelope.js';
import { db } from '../lib/db.js';

const KEY = process.env.ETHERSCAN_API_KEY || '';
const BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_IDS = { eth: 1, base: 8453, arbitrum: 42161, bsc: 56, polygon: 137 };

/**
 * Known exchange deposit/hot wallets. Maintained by us in Supabase
 * (`labeled_addresses`), seeded with public, well-documented addresses.
 * We label addresses ourselves — we do not license labels from a prohibited
 * provider, and this list is part of the moat rather than a rented input.
 */
let LABELS = null;
async function labels() {
  if (LABELS) return LABELS;
  LABELS = new Map();
  if (db) {
    const { data } = await db.from('labeled_addresses').select('address,label,category');
    (data || []).forEach((r) => LABELS.set(r.address.toLowerCase(), r));
  }
  return LABELS;
}

export async function deployerIntel(chain, contractAddress) {
  if (!KEY) return unavailable('Etherscan', 'ETHERSCAN_API_KEY is not set, so deployer intelligence is disabled.');
  const chainid = CHAIN_IDS[chain];
  if (!chainid || !contractAddress) return unavailable('Etherscan', 'No contract address is mapped for this asset on a supported chain.');

  try {
    const creation = await get('etherscan', `${BASE}?chainid=${chainid}&module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&apikey=${KEY}`);
    const row = creation?.result?.[0];
    if (!row?.contractCreator) return unavailable('Etherscan', 'Contract creation record not found.');

    const deployer = row.contractCreator;

    // Deployer's recent outbound transfers, checked against our labeled-address list.
    const txs = await get('etherscan', `${BASE}?chainid=${chainid}&module=account&action=txlist&address=${deployer}&startblock=0&endblock=99999999&page=1&offset=100&sort=desc&apikey=${KEY}`);
    const list = Array.isArray(txs?.result) ? txs.result : [];
    const map = await labels();
    const cutoff = Date.now() / 1000 - 86400;

    const recentOutbound = list.filter((t) => t.from?.toLowerCase() === deployer.toLowerCase() && Number(t.timeStamp) > cutoff);
    const exchangeTransfers = recentOutbound
      .filter((t) => map.has((t.to || '').toLowerCase()) && map.get((t.to || '').toLowerCase()).category === 'exchange')
      .map((t) => ({ tx_hash: t.hash, to: t.to, label: map.get(t.to.toLowerCase()).label, value_wei: t.value, at: new Date(Number(t.timeStamp) * 1000).toISOString() }));

    const firstTx = list[list.length - 1];
    const deployedAt = row.timestamp ? Number(row.timestamp) * 1000 : (firstTx ? Number(firstTx.timeStamp) * 1000 : null);
    const deployedDaysAgo = deployedAt ? Math.floor((Date.now() - deployedAt) / 86400000) : null;

    const observations = [];
    if (exchangeTransfers.length) {
      observations.push(`The deployer transferred assets to a known exchange address ${exchangeTransfers.length} time(s) in the past 24 hours. Review the transactions before drawing a conclusion.`);
    }
    if (deployedDaysAgo != null && deployedDaysAgo < 7) {
      observations.push(`The contract was deployed ${deployedDaysAgo} day(s) ago. Very new contracts carry higher uncertainty across every risk dimension.`);
    }
    if (!observations.length) {
      observations.push('No exchange transfers were observed from the deployer address in the past 24 hours.');
    }

    return envelope({
      deployer_address: deployer,
      deploy_tx: row.txHash,
      deployed_days_ago: deployedDaysAgo,
      deployer_outbound_24h: recentOutbound.length,
      deployer_sent_to_exchange_24h: exchangeTransfers.length > 0,
      exchange_transfers: exchangeTransfers,
      observations,
      unavailable_inputs: [
        { name: 'Contract security audit status', reason: 'Requires a security-scanner integration. Not connected.' },
      ],
    }, { status: STATUS.LIVE, source: 'Etherscan V2', note: 'Observations only. ChainQuant does not label a project a scam or a rug.' });
  } catch {
    return unavailable('Etherscan', 'Deployer data could not be retrieved.');
  }
}
