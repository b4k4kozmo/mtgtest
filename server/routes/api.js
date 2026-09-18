import express from 'express';
import { ScryfallError } from '../lib/scryfall.js';
import { buildCardPricing, referenceLinksFor, printingSummary, SUPPORTED_CURRENCIES } from '../lib/offers.js';
import { priceDeckList, MAX_DECK_ENTRIES } from '../lib/deckPricing.js';
import { VENDORS } from '../lib/vendors.js';
import { readShippingOptions, defaultShippingFor } from '../lib/shipping.js';
import { findDeals, DEAL_THEMES } from '../lib/deals.js';

const FINISHES = new Set(['any', 'nonfoil', 'foil', 'etched']);

/**
 * Basic lands have well over a thousand printings. Showing every row helps
 * nobody, so the response carries the cheapest slice plus an honest count.
 */
const MAX_OFFERS_RETURNED = 250;

export function createApiRouter({ scryfall, ebay }) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      priceSource: 'Scryfall (TCGplayer + Cardmarket daily price data)',
      liveListings: { ebay: ebay.configured },
      shipping: {
        USD: defaultShippingFor('USD'),
        EUR: defaultShippingFor('EUR'),
        note: 'Estimates you can edit. Only eBay reports a real per-listing shipping cost.',
      },
      dealThemes: DEAL_THEMES.map(({ id, label }) => ({ id, label })),
      vendors: Object.values(VENDORS).map(({ id, name, priority, kind, region, note }) => ({
        id, name, priority, kind, region, note,
      })),
    });
  });

  /** A rotating strip of genuinely cheap cards that people actually play. */
  router.get('/deals', asyncRoute(async (req, res) => {
    const { currency, includeCollectibles } = readPricingOptions(req.query);
    const shipping = readShippingOptions(req.query, currency);
    const result = await findDeals({
      scryfall,
      currency,
      shipping,
      includeCollectibles,
      limit: clampInt(req.query.limit, 16, 4, 30),
      themeId: req.query.theme ? String(req.query.theme) : null,
    });
    res.json({ ...result, currency, shipping });
  }));

  // Card-name suggestions for the search box.
  router.get('/autocomplete', asyncRoute(async (req, res) => {
    const names = await scryfall.autocomplete(req.query.q);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ names });
  }));

  /**
   * Resolve a search term to one card and price every genuine printing of it.
   * `q` may be a card name (fuzzy) and `id` a specific Scryfall printing id.
   */
  router.get('/card', asyncRoute(async (req, res) => {
    const options = readPricingOptions(req.query);
    options.shipping = readShippingOptions(req.query, options.currency);
    const card = req.query.id
      ? await scryfall.cardById(req.query.id)
      : await scryfall.named(req.query.q, { exact: req.query.exact === 'true' });

    const printings = await scryfall.printingsByOracleId(card.oracle_id);
    const source = printings.length > 0 ? printings : [card];
    const pricing = buildCardPricing(source, options);
    const totalOffers = pricing.offers.length;
    const offersTruncated = totalOffers > MAX_OFFERS_RETURNED;
    if (offersTruncated) pricing.offers = pricing.offers.slice(0, MAX_OFFERS_RETURNED);
    pricing.totalOffers = totalOffers;
    pricing.offersTruncated = offersTruncated;

    res.json({
      card: {
        ...printingSummary(card),
        oracleText: card.oracle_text ?? null,
        faces: (card.card_faces ?? []).map((face) => ({
          name: face.name,
          typeLine: face.type_line,
          manaCost: face.mana_cost,
          oracleText: face.oracle_text,
        })),
        legalities: card.legalities ?? {},
        reprintCount: source.length,
      },
      pricing,
      links: referenceLinksFor(card),
      liveListings: { ebay: ebay.configured },
    });
  }));

  /** Live marketplace listings with seller photos (eBay, when configured). */
  router.get('/listings', asyncRoute(async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A card name is required.' });
    const result = await ebay.searchListings(name, {
      setName: req.query.set ? String(req.query.set) : null,
      limit: clampInt(req.query.limit, 8, 1, 20),
    });
    res.json(result);
  }));

  /** Free-text search, for "show me everything matching this". */
  router.get('/search', asyncRoute(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ cards: [] });
    const cards = await scryfall.searchCards(query, { limit: clampInt(req.query.limit, 24, 1, 60) });
    res.json({ cards: cards.map(printingSummary) });
  }));

  /** Price a whole deck list. */
  router.post('/deck', asyncRoute(async (req, res) => {
    const list = typeof req.body?.list === 'string' ? req.body.list : '';
    if (list.trim() === '') {
      return res.status(400).json({ error: 'Paste a deck list first.' });
    }
    const { currency, includeCollectibles } = readPricingOptions(req.body);
    const shipping = readShippingOptions(req.body, currency);
    const result = await priceDeckList(list, { scryfall, currency, includeCollectibles, shipping });
    res.json({ ...result, maxEntries: MAX_DECK_ENTRIES });
  }));

  // Route-level error translation, so clients always get JSON.
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof ScryfallError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(`[api] ${req.method} ${req.originalUrl}`, err);
    return res.status(500).json({ error: 'Something went wrong handling that request.' });
  });

  return router;
}

function readPricingOptions(source = {}) {
  const requested = String(source.currency || 'USD').toUpperCase();
  const currency = SUPPORTED_CURRENCIES.includes(requested) ? requested : 'USD';
  const finishRaw = String(source.finish || 'any');
  return {
    currency,
    finish: FINISHES.has(finishRaw) ? finishRaw : 'any',
    includeCollectibles: source.includeCollectibles === true || source.includeCollectibles === 'true',
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** Forward async rejections into Express' error pipeline. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
