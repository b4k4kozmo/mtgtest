import { boltPrintings, splitCard, dfcCard } from '../fixtures/cards.js';
import { ScryfallError } from '../../server/lib/scryfall.js';
import { normalizeName } from '../../server/lib/deckPricing.js';

/**
 * Stand-in for the Scryfall client with the same surface, backed by fixtures.
 * Lets the route + deck-pricing tests run without touching the network.
 */
export function createFakeScryfall() {
  const catalogue = [...boltPrintings, splitCard, dfcCard];
  const calls = { collection: 0, printingsByOracleIds: 0, cheapestPrintingsByOracleIds: 0, printingsByOracleId: 0, searchCards: 0 };
  let lastSearch = null;

  const printingsFor = (oracleId) => catalogue.filter((card) => card.oracle_id === oracleId);
  // Scryfall itself is lenient about punctuation and accents in names.
  const normalize = (value) => normalizeName(String(value ?? ''));

  return {
    calls,
    async autocomplete(query) {
      const q = normalize(query);
      return [...new Set(catalogue.map((c) => c.name))].filter((name) => normalize(name).includes(q));
    },
    async named(query) {
      const q = normalize(query);
      const match =
        catalogue.find((c) => normalize(c.name) === q) ??
        catalogue.find((c) => normalize(c.name).includes(q));
      if (!match) throw new ScryfallError('No card found.', { status: 404, code: 'not_found' });
      return match;
    },
    async cardById(id) {
      const match = catalogue.find((c) => c.id === id);
      if (!match) throw new ScryfallError('No card found.', { status: 404, code: 'not_found' });
      return match;
    },
    async printingsByOracleId(oracleId) {
      calls.printingsByOracleId += 1;
      return printingsFor(oracleId);
    },
    async printingsByOracleIds(oracleIds) {
      calls.printingsByOracleIds += 1;
      return new Map([...new Set(oracleIds)].map((id) => [id, printingsFor(id)]));
    },
    async cheapestPrintingsByOracleIds(oracleIds, { currency = 'USD' } = {}) {
      calls.cheapestPrintingsByOracleIds += 1;
      const key = currency === 'EUR' ? 'eur' : 'usd';
      // Mirror the real query: paper printings that have a price, cheapest first.
      return new Map(
        [...new Set(oracleIds)].map((id) => [
          id,
          printingsFor(id)
            .filter((c) => !c.digital && (c.games ?? ['paper']).includes('paper') && Number.parseFloat(c.prices?.[key]) > 0)
            .sort((a, b) => Number.parseFloat(a.prices[key]) - Number.parseFloat(b.prices[key])),
        ]),
      );
    },
    async searchCards(query, { unique = 'cards' } = {}) {
      calls.searchCards += 1;
      lastSearch = { query: String(query), unique };
      const raw = String(query);
      // A query using Scryfall operators (f:commander, usd>=0.25, ...) is a
      // catalogue filter, not a name lookup.
      const isOperatorQuery = /[:<>]/.test(raw);
      const matches = isOperatorQuery
        ? catalogue
        : catalogue.filter((c) => normalize(c.name).includes(normalize(raw)));
      if (unique !== 'cards') return matches;
      const seen = new Set();
      return matches.filter((c) => {
        if (seen.has(c.oracle_id)) return false;
        seen.add(c.oracle_id);
        return true;
      });
    },
    get lastSearch() {
      return lastSearch;
    },
    async collection(identifiers) {
      calls.collection += 1;
      const found = [];
      const notFound = [];
      for (const identifier of identifiers) {
        let match = null;
        if (identifier.set && identifier.collector_number) {
          match = catalogue.find(
            (c) =>
              normalize(c.set) === normalize(identifier.set) &&
              normalize(c.collector_number) === normalize(identifier.collector_number),
          );
        }
        if (!match && identifier.name) {
          const wanted = normalize(identifier.name);
          match = catalogue.find((c) => {
            if (normalize(c.name) === wanted) return true;
            if (c.name.includes('//') && c.name.split('//').some((half) => normalize(half) === wanted)) return true;
            return (c.card_faces ?? []).some((face) => normalize(face.name) === wanted);
          });
        }
        if (match) found.push(match);
        else notFound.push(identifier);
      }
      return { found, notFound };
    },
  };
}

export function createFakeEbay({ configured = false, listings = [] } = {}) {
  return {
    configured,
    async searchListings() {
      return { configured, listings, error: null };
    },
  };
}
