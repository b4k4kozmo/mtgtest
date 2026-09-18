import { parseDeckList, toScryfallIdentifiers } from './deckParser.js';
import { buildCardPricing, printingSummary, referenceLinksFor } from './offers.js';

export const MAX_DECK_ENTRIES = 600;

/**
 * Price a pasted deck list: resolve every line to a real card, then find the
 * cheapest genuine printing of each.
 */
export async function priceDeckList(text, { scryfall, currency = 'USD', includeCollectibles = false } = {}) {
  const parsed = parseDeckList(text);
  const errors = [...parsed.errors];

  let entries = parsed.entries;
  if (entries.length > MAX_DECK_ENTRIES) {
    errors.push({
      lineNumber: 0,
      line: '',
      message: `Only the first ${MAX_DECK_ENTRIES} distinct cards were priced (${entries.length} were submitted).`,
    });
    entries = entries.slice(0, MAX_DECK_ENTRIES);
  }

  if (entries.length === 0) {
    return emptyResult(currency, errors, parsed);
  }

  const { found, notFound } = await scryfall.collection(toScryfallIdentifiers(entries));
  const index = indexFoundCards(found);

  const resolved = entries.map((entry) => ({ entry, card: lookupCard(index, entry) }));
  const oracleIds = resolved.map((r) => r.card?.oracle_id).filter(Boolean);
  const printingsByOracleId = await scryfall.cheapestPrintingsByOracleIds(oracleIds, { currency });

  const cards = [];
  const missing = [];

  for (const { entry, card } of resolved) {
    if (!card) {
      missing.push({
        quantity: entry.quantity,
        name: entry.name,
        section: entry.section,
        line: entry.line,
        lineNumber: entry.lineNumber,
        reason: 'No card with that name (or that set / collector number) exists.',
      });
      continue;
    }

    let printings = printingsByOracleId.get(card.oracle_id) ?? [card];
    let pricing = buildCardPricing(printings, { currency, includeCollectibles, finish: entry.finish });

    // The fast lookup keeps only the cheapest page; if everything on it was
    // filtered out as non-genuine, fall back to the card's full print run.
    if (!pricing.cheapest && scryfall.printingsByOracleId) {
      try {
        const full = await scryfall.printingsByOracleId(card.oracle_id);
        if (full.length > 0) {
          printings = full;
          pricing = buildCardPricing(printings, { currency, includeCollectibles, finish: entry.finish });
        }
      } catch {
        // Keep the fast-path result rather than failing the whole deck.
      }
    }

    let finishRelaxed = false;
    if (!pricing.cheapest && entry.finish !== 'any') {
      // The requested finish has no price anywhere; fall back rather than
      // dropping the card out of the total, and say so in the response.
      pricing = buildCardPricing(printings, { currency, includeCollectibles, finish: 'any' });
      finishRelaxed = pricing.cheapest !== null;
    }

    const cheapest = pricing.cheapest;
    const requestedPrinting =
      entry.set && entry.collectorNumber ? printingSummary(card) : null;

    cards.push({
      quantity: entry.quantity,
      section: entry.section,
      requested: {
        name: entry.name,
        set: entry.set,
        collectorNumber: entry.collectorNumber,
        finish: entry.finish,
      },
      line: entry.line,
      lineNumber: entry.lineNumber,
      name: card.name,
      oracleId: card.oracle_id,
      scryfallUri: card.scryfall_uri,
      typeLine: card.type_line,
      images: printingSummary(card).images,
      cheapest,
      alternatives: pricing.similar.filter((offer) => offer.id !== cheapest?.id).slice(0, 4),
      requestedPrinting,
      finishRelaxed,
      unitPrice: cheapest?.price ?? null,
      lineTotal: cheapest ? Number((cheapest.price * entry.quantity).toFixed(2)) : null,
      priced: Boolean(cheapest),
      links: referenceLinksFor(card),
      excludedCount: pricing.counts.printingsExcluded,
    });
  }

  for (const identifier of notFound) {
    const label = identifier.name ?? `${(identifier.set ?? '').toUpperCase()} ${identifier.collector_number ?? ''}`.trim();
    if (!missing.some((m) => m.name.toLowerCase() === String(label).toLowerCase())) {
      missing.push({ quantity: 0, name: label, section: null, line: label, lineNumber: 0, reason: 'Scryfall found no match.' });
    }
  }

  return {
    currency,
    includeCollectibles,
    parse: { errors, totalCards: parsed.totalCards, sections: parsed.sections },
    cards,
    missing,
    totals: summarise(cards, currency),
  };
}

function summarise(cards, currency) {
  let total = 0;
  let pricedCards = 0;
  let unpricedCards = 0;
  let cardCount = 0;
  const bySection = new Map();

  for (const card of cards) {
    cardCount += card.quantity;
    if (card.priced) {
      total += card.lineTotal;
      pricedCards += card.quantity;
      const section = bySection.get(card.section) ?? { section: card.section, total: 0, cards: 0 };
      section.total += card.lineTotal;
      section.cards += card.quantity;
      bySection.set(card.section, section);
    } else {
      unpricedCards += card.quantity;
    }
  }

  return {
    currency,
    total: Number(total.toFixed(2)),
    cardCount,
    pricedCards,
    unpricedCards,
    distinctCards: cards.length,
    bySection: [...bySection.values()].map((s) => ({ ...s, total: Number(s.total.toFixed(2)) })),
  };
}

/**
 * Scryfall's collection endpoint does not promise result order, so index the
 * results every way an entry might refer to them.
 */
function indexFoundCards(cards) {
  const byName = new Map();
  const bySetNumber = new Map();
  for (const card of cards) {
    for (const key of nameKeys(card)) {
      if (!byName.has(key)) byName.set(key, card);
    }
    bySetNumber.set(setNumberKey(card.set, card.collector_number), card);
  }
  return { byName, bySetNumber };
}

function nameKeys(card) {
  const keys = new Set();
  const add = (value) => {
    const key = normalizeName(value);
    if (key) keys.add(key);
  };
  add(card.name);
  if (typeof card.name === 'string' && card.name.includes('//')) {
    for (const half of card.name.split('//')) add(half);
  }
  for (const face of card.card_faces ?? []) add(face?.name);
  return keys;
}

function lookupCard(index, entry) {
  if (entry.set && entry.collectorNumber) {
    const exact = index.bySetNumber.get(setNumberKey(entry.set, entry.collectorNumber));
    if (exact) return exact;
  }
  return index.byName.get(normalizeName(entry.name)) ?? null;
}

/**
 * Fold the differences between what people type and what Scryfall returns:
 * typographic apostrophes ("Agadeem’s" vs "Agadeem's"), en/em dashes, and
 * accents ("Lim-Dûl's Vault" typed as "Lim-Dul's Vault").
 */
export const normalizeName = (value) =>
  typeof value === 'string'
    ? value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[\u2018\u2019\u02BC\u201B]/g, "'")
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    : '';

const setNumberKey = (set, collectorNumber) =>
  `${String(set ?? '').toLowerCase()}|${String(collectorNumber ?? '').toLowerCase()}`;

function emptyResult(currency, errors, parsed) {
  return {
    currency,
    includeCollectibles: false,
    parse: { errors, totalCards: parsed.totalCards, sections: parsed.sections },
    cards: [],
    missing: [],
    totals: {
      currency,
      total: 0,
      cardCount: 0,
      pricedCards: 0,
      unpricedCards: 0,
      distinctCards: 0,
      bySection: [],
    },
  };
}
