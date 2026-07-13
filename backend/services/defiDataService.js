/** defiDataService — DefiLlama. Free, keyless, commercially usable. */
import { get } from '../lib/http.js';
import { envelope, STATUS } from '../lib/envelope.js';

const BASE = 'https://api.llama.fi';

export async function fetchProtocols() {
  const d = await get('defillama', `${BASE}/protocols`);
  return envelope(d, { status: STATUS.LIVE, source: 'DefiLlama' });
}

export async function fetchChains() {
  const d = await get('defillama', `${BASE}/v2/chains`);
  return envelope(d, { status: STATUS.LIVE, source: 'DefiLlama' });
}
