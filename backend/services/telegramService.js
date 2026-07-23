/**
 * telegramService — honest-unavailable by default.
 *
 * server.js routes /api/telegram/:symbol here, but no such file existed in the
 * repo, so the API failed to boot (ERR_MODULE_NOT_FOUND) before serving a single
 * request. This restores boot and keeps the surface honest: there is no free,
 * general symbol -> Telegram-group mapping, so unless TELEGRAM_BOT_TOKEN is set
 * (and a group is resolvable) we return UNAVAILABLE rather than a guessed member
 * count. Same discipline as socialIntelligenceService.
 */
import { unavailable, envelope, STATUS } from '../lib/envelope.js';

const KEY = process.env.TELEGRAM_BOT_TOKEN || '';

export async function telegramMembers(symbol) {
  if (!KEY) {
    return unavailable('Telegram', 'Telegram community metrics are not connected. No member count is shown because none can be verified for this symbol.');
  }
  // Implemented on connection: resolve symbol -> public group, then
  // getChatMemberCount via the Bot API. Until then, no invented number.
  return envelope(null, { status: STATUS.UNAVAILABLE, source: 'Telegram Bot API', note: 'Adapter stub — wire on token + symbol→group mapping.' });
}
