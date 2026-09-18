/**
 * Transport: talks to Scryfall directly from the browser.
 *
 * Scryfall serves `Access-Control-Allow-Origin: *`, so the whole app runs as a
 * static site with no backend — real cards, real prices, real card images, every
 * printing. This module is the drop-in replacement for `public/api.js`: same
 * function names, same response shapes, composed from the very modules the Node
 * routes use.
 *
 * The one thing it cannot do is eBay. That needs an OAuth client secret, which
 * has no safe home in a page anyone can view, so `listings()` always reports
 * "not configured" and the UI falls back to pre-filtered eBay search links.
 */
import { createScryfallClient } from '../server/lib/scryfall.js';
import { buildCardPricing, printingSummary, referenceLinksFor } from '../server/lib/offers.js';
import { priceDeckList } from '../server/lib/deckPricing.js';
import { findDeals, DEAL_THEMES } from '../server/lib/deals.js';
import { readShippingOptions, defaultShippingFor } from '../server/lib/shipping.js';
import { VENDORS } from '../server/lib/vendors.js';

const MAX_OFFERS_RETURNED = 250;

export const mode = 'direct';

export function createApi({ fetchImpl = globalThis.fetch } = {}) {
  // No custom headers: keeps every GET a simple CORS request, so Scryfall is
  // reached without a preflight round trip on each call.
  const scryfall = createScryfallClient({ fetchImpl, headers: {} });

  const pricingOptions = (source = {}) => {
    const requested = String(source.currency || 'USD').toUpperCase();
    const currency = requested === 'EUR' ? 'EUR' : 'USD';
    return {
      currency,
      includeCollectibles: source.includeCollectibles === true || source.includeCollectibles === 'true',
      shipping: readShippingOptions(source, currency),
    };
  };

  return {
    mode,
    scryfall,

    async health() {
      return {
        ok: true,
        mode,
        priceSource: 'Scryfall (TCGplayer + Cardmarket daily price data), read live from your browser',
        liveListings: { ebay: false },
        shipping: { USD: defaultShippingFor('USD'), EUR: defaultShippingFor('EUR') },
        dealThemes: DEAL_THEMES.map(({ id, label }) => ({ id, label })),
        vendors: Object.values(VENDORS).map(({ id, name, priority, kind, region, note }) => ({
          id, name, priority, kind, region, note,
        })),
      };
    },

    async autocomplete(params) {
      return { names: await scryfall.autocomplete(params.q) };
    },

    async card(params) {
      const options = pricingOptions(params);
      const found = params.id
        ? await scryfall.cardById(params.id)
        : await scryfall.named(params.q);

      const printings = await scryfall.printingsByOracleId(found.oracle_id);
      const source = printings.length > 0 ? printings : [found];
      const pricing = buildCardPricing(source, options);

      const totalOffers = pricing.offers.length;
      pricing.offersTruncated = totalOffers > MAX_OFFERS_RETURNED;
      if (pricing.offersTruncated) pricing.offers = pricing.offers.slice(0, MAX_OFFERS_RETURNED);
      pricing.totalOffers = totalOffers;

      return {
        card: {
          ...printingSummary(found),
          oracleText: found.oracle_text ?? null,
          faces: (found.card_faces ?? []).map((face) => ({
            name: face.name, typeLine: face.type_line, manaCost: face.mana_cost, oracleText: face.oracle_text,
          })),
          legalities: found.legalities ?? {},
          reprintCount: source.length,
        },
        pricing,
        links: referenceLinksFor(found),
        liveListings: { ebay: false },
      };
    },

    async search(params) {
      const cards = await scryfall.searchCards(params.q, { limit: Number(params.limit) || 24 });
      return { cards: cards.map(printingSummary) };
    },

    async listings() {
      // An OAuth secret cannot live in a public page; the UI degrades to links.
      return { configured: false, listings: [], error: null };
    },

    async deals(params) {
      const { currency, includeCollectibles, shipping } = pricingOptions(params);
      const result = await findDeals({
        scryfall, currency, shipping, includeCollectibles,
        limit: Number(params.limit) || 16,
        themeId: params.theme ?? null,
      });
      return { ...result, currency, shipping };
    },

    async deck(body) {
      const { currency, includeCollectibles, shipping } = pricingOptions(body);
      const list = typeof body?.list === 'string' ? body.list : '';
      if (list.trim() === '') throw new Error('Paste a deck list first.');
      return priceDeckList(list, { scryfall, currency, includeCollectibles, shipping });
    },
  };
}

const api = createApi();
export const health = (p) => api.health(p);
export const autocomplete = (p) => api.autocomplete(p);
export const card = (p) => api.card(p);
export const search = (p) => api.search(p);
export const listings = (p) => api.listings(p);
export const deals = (p) => api.deals(p);
export const deck = (p) => api.deck(p);
