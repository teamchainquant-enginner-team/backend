/**
 * socialIntelligenceService — deliberately, honestly empty.
 *
 * There is no free source that gives real X/social momentum. The old terminal
 * filled this gap with Math.random() and labelled it a live signal. This service
 * exists so that the gap is visible in the architecture instead of papered over:
 * until TWITTERAPI_IO_KEY is purchased, every social surface returns UNAVAILABLE
 * and the UI says so.
 */
import { unavailable, envelope, STATUS } from '../lib/envelope.js';

const KEY = process.env.TWITTERAPI_IO_KEY || '';

export async function socialMomentum(symbol) {
  if (!KEY) {
    return unavailable('TwitterAPI.io', 'Social API connection pending. No social momentum figure is shown because none can be measured.');
  }
  // Implemented on purchase. Until then we do not ship a number we cannot stand behind.
  return envelope(null, { status: STATUS.UNAVAILABLE, source: 'TwitterAPI.io', note: 'Adapter stub — wire on key purchase.' });
}
