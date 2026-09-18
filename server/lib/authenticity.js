/**
 * Authenticity rules.
 *
 * Two separate jobs live here:
 *
 *  1. `classifyPrinting()` decides whether a Scryfall printing is a genuine,
 *     physical, playable Magic card that a person could actually buy. Scryfall
 *     only indexes cards printed by Wizards of the Coast, so counterfeits never
 *     enter the catalogue -- but it *does* index digital-only printings and
 *     "memorabilia" (Collector's Edition, gold-bordered World Championship
 *     decks, the 30th Anniversary Edition). Those are the products most often
 *     resold as, or mistaken for, proxies: they are not tournament legal and
 *     some do not even share the real Magic card back. They are excluded by
 *     default.
 *
 *  2. `looksLikeProxyListing()` screens free-text marketplace listing titles
 *     (eBay and friends) for the vocabulary proxy sellers use.
 */

/** Set codes that are official products but are not real, playable cards. */
export const NON_PLAYABLE_SET_CODES = new Set([
  'ced', // Collector's Edition -- square corners, not tournament legal
  'cei', // International Collector's Edition -- ditto
  '30a', // 30th Anniversary Edition -- non-standard card back
  'wc97', 'wc98', 'wc99', 'wc00', 'wc01', 'wc02', 'wc03', 'wc04', // gold-bordered
  'ptc', // Pro Tour Collector Set -- gold-bordered
]);

/** Scryfall `set_type` values that never yield a playable single. */
export const EXCLUDED_SET_TYPES = new Set([
  'memorabilia', // CE/IE, 30A, World Championship decks, art prints
  'token',
  'minigame',
  'alchemy', // digital-only Arena rebalances
]);

/** Scryfall `layout` values that are not the card itself. */
export const EXCLUDED_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'vanguard',
  'scheme',
  'planar',
  'augment',
  'host',
]);

/**
 * Words proxy / counterfeit / custom-card sellers use in listing titles.
 * Deliberately broad: a false negative puts a fake in front of a buyer, while a
 * false positive just drops one listing out of a long list.
 */
const PROXY_TITLE_TERMS = [
  'proxy', 'proxies', 'proxied',
  'counterfeit', 'fake', 'replica', 'repro', 'reproduction', 'knockoff', 'knock off',
  'custom made', 'custom card', 'custom magic', 'custom mtg', 'fan made', 'fan-made',
  'not tournament legal', 'not for tournament', 'unofficial', 'bootleg',
  'altered art', 'alter art', 'hand painted', 'handpainted', 'extended by hand',
  'playtest card', 'play test card', 'test print', 'testprint',
  'cnc ', 'high quality copy', 'hq copy', 'copy of ', 'replica card',
  'gold border', 'gold-bordered', 'silver border collectors',
  'digital only', 'mtgo code', 'arena code', 'code card',
];

const PROXY_TITLE_PATTERN = new RegExp(
  PROXY_TITLE_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

/** Negative keywords appended to marketplace search URLs. */
export const MARKETPLACE_NEGATIVE_KEYWORDS = [
  'proxy', 'proxies', 'custom', 'fake', 'replica', 'reproduction', 'repro',
  'altered', 'counterfeit', 'bootleg', 'playtest', 'lot', 'bundle',
];

/**
 * @param {object} card A Scryfall card (printing) object.
 * @param {{ includeCollectibles?: boolean }} [options]
 * @returns {{ ok: boolean, reason: string|null, code: string|null }}
 */
export function classifyPrinting(card, options = {}) {
  const { includeCollectibles = false } = options;
  if (!card || typeof card !== 'object') {
    return reject('not_a_card', 'Not a card object.');
  }

  if (card.digital === true) {
    return reject('digital', 'Digital-only printing (Magic Online / Arena) — not a physical card.');
  }

  const games = Array.isArray(card.games) ? card.games : [];
  if (games.length > 0 && !games.includes('paper')) {
    return reject('not_paper', 'This printing was never released on paper.');
  }

  if (EXCLUDED_LAYOUTS.has(card.layout)) {
    return reject('layout', `"${card.layout}" printings are not playable singles.`);
  }

  const setCode = String(card.set || '').toLowerCase();
  const setType = String(card.set_type || '').toLowerCase();
  const isCollectible =
    EXCLUDED_SET_TYPES.has(setType) ||
    NON_PLAYABLE_SET_CODES.has(setCode) ||
    card.border_color === 'gold';

  if (isCollectible && !includeCollectibles) {
    return reject(
      'collectible',
      'Collector/memorabilia printing (Collector’s Edition, gold-bordered World Championship, 30th Anniversary) — not a tournament-legal card.',
    );
  }

  // Always excluded, even with `includeCollectibles`: an oversized card is
  // physically unplayable, so it is never the answer to "where is this cheap".
  if (card.oversized === true) {
    return reject('oversized', 'Oversized display card — cannot be played.');
  }

  return { ok: true, reason: null, code: null };
}

function reject(code, reason) {
  return { ok: false, reason, code };
}

/** True when a marketplace listing title advertises a proxy / fake / custom card. */
export function looksLikeProxyListing(title) {
  if (typeof title !== 'string' || title.length === 0) return false;
  return PROXY_TITLE_PATTERN.test(title);
}

/**
 * A listing must also plausibly be the card that was searched for. Guards
 * against marketplace search returning "sleeves featuring Lightning Bolt".
 */
export function titleMentionsCard(title, cardName) {
  if (typeof title !== 'string' || typeof cardName !== 'string') return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const haystack = normalize(title);
  // Split cards ("Fire // Ice") match on either half.
  const candidates = cardName.split('//').map((part) => normalize(part)).filter(Boolean);
  return candidates.some((needle) => needle.length > 0 && haystack.includes(needle));
}
