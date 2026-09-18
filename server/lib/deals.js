import { buildCardPricing } from './offers.js';

/**
 * "Good deals right now."
 *
 * A deal here is a real, checkable claim, not a marketing number: a card that
 * lots of people actually play (Scryfall exposes EDHREC play rank, and
 * `order=edhrec` sorts by it) that currently sits in a low price band. Where
 * the same card also has a much pricier printing, the gap is reported too --
 * that gap is computed from the same price-ascending page the cheapest
 * printing came from, so it is measured, not estimated.
 *
 * Nothing is fabricated: if Scryfall returns nothing for a theme, the strip
 * simply does not appear.
 */

/** Price bands are in the selected currency; `p` is the price field to filter on. */
export const DEAL_THEMES = [
  {
    id: 'commander-staples',
    label: 'Commander staples going cheap',
    blurb: 'Heavily played in Commander, and under {max} right now.',
    min: 0.3,
    max: 4,
    query: (p, min, max) => `f:commander game:paper -is:digital ${p}>=${min} ${p}<=${max}`,
  },
  {
    id: 'modern-staples',
    label: 'Modern staples under {max}',
    blurb: 'Modern-legal rares and mythics that have come down in price.',
    min: 0.5,
    max: 8,
    query: (p, min, max) => `f:modern game:paper -is:digital r>=rare ${p}>=${min} ${p}<=${max}`,
  },
  {
    id: 'pauper-power',
    label: 'Pauper power for pocket change',
    blurb: 'Commons that carry whole Pauper decks.',
    min: 0.15,
    max: 3,
    query: (p, min, max) => `f:pauper game:paper -is:digital ${p}>=${min} ${p}<=${max}`,
  },
  {
    id: 'cheap-mythics',
    label: 'Mythics under {max}',
    blurb: 'Mythic rares that reprints have brought within reach.',
    min: 0.25,
    max: 3,
    query: (p, min, max) => `game:paper -is:digital r:mythic is:reprint ${p}>=${min} ${p}<=${max}`,
  },
  {
    id: 'legacy-staples',
    label: 'Legacy and Vintage staples under {max}',
    blurb: 'Eternal-format cards that are cheaper than their reputation.',
    min: 1,
    max: 12,
    query: (p, min, max) => `f:legacy game:paper -is:digital r>=rare ${p}>=${min} ${p}<=${max}`,
  },
];

/** A printing has to be this much dearer than the cheapest to be worth naming. */
const NOTABLE_SAVINGS_RATIO = 2.5;

const CANDIDATE_POOL = 40;

/**
 * @param {{ scryfall: object, currency?: string, shipping?: object|null,
 *           limit?: number, themeId?: string, random?: () => number }} options
 */
export async function findDeals({
  scryfall,
  currency = 'USD',
  shipping = null,
  includeCollectibles = false,
  limit = 16,
  themeId = null,
  random = Math.random,
} = {}) {
  const theme = DEAL_THEMES.find((t) => t.id === themeId) ?? pick(DEAL_THEMES, random);
  const priceField = currency === 'EUR' ? 'eur' : 'usd';
  const query = theme.query(priceField, theme.min, theme.max);

  // Most-played first, so the pool is cards people actually want.
  const popular = await scryfall.searchCards(query, {
    unique: 'cards',
    order: 'edhrec',
    dir: 'asc',
    limit: CANDIDATE_POOL,
  });
  if (popular.length === 0) return { theme: describe(theme, currency), deals: [] };

  const candidates = shuffle(popular, random).slice(0, limit * 2);
  const oracleIds = candidates.map((card) => card.oracle_id).filter(Boolean);
  const printingsByOracleId = await scryfall.cheapestPrintingsByOracleIds(oracleIds, { currency });

  const deals = [];
  for (const card of candidates) {
    if (deals.length >= limit) break;
    const printings = printingsByOracleId.get(card.oracle_id) ?? [];
    if (printings.length === 0) continue;

    const pricing = buildCardPricing(printings, { currency, includeCollectibles, shipping });
    const cheapest = pricing.cheapest;
    if (!cheapest) continue;

    deals.push({
      name: card.name,
      oracleId: card.oracle_id,
      typeLine: card.type_line ?? null,
      scryfallUri: card.scryfall_uri,
      // The art shown is the printing you would actually be buying.
      images: cheapest.printing.images,
      offer: cheapest,
      ...savingsAgainstDearestPrinting(pricing.offers),
    });
  }

  return { theme: describe(theme, currency), deals };
}

/**
 * How much cheaper the cheapest printing is than the priciest printing of the
 * same card. Reported only when the gap is big enough to be worth a shopper's
 * attention.
 *
 * Finishes are compared like with like: a foil costing eight times its
 * non-foil twin is ordinary foil pricing, not a deal, and quoting it as one
 * would overstate every saving on the page.
 */
function savingsAgainstDearestPrinting(offers) {
  if (offers.length < 2) return { dearestPrice: null, savingsPercent: null };
  const cheapestOffer = offers[0];
  const sameFinish = offers.filter((offer) => offer.finish === cheapestOffer.finish);
  if (sameFinish.length < 2) return { dearestPrice: null, savingsPercent: null };

  const cheapest = cheapestOffer.price;
  const dearest = sameFinish.reduce((max, offer) => Math.max(max, offer.price), 0);
  if (!(dearest >= cheapest * NOTABLE_SAVINGS_RATIO)) {
    return { dearestPrice: null, savingsPercent: null };
  }
  return {
    dearestPrice: dearest,
    // Floored, so the figure never overstates the gap.
    savingsPercent: Math.floor((1 - cheapest / dearest) * 100),
  };
}

function describe(theme, currency) {
  const symbol = currency === 'EUR' ? '€' : '$';
  const max = `${symbol}${theme.max}`;
  return {
    id: theme.id,
    label: theme.label.replace('{max}', max),
    blurb: theme.blurb.replace('{max}', max),
  };
}

const pick = (list, random) => list[Math.floor(random() * list.length) % list.length];

function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
