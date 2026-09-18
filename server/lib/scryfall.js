import { TtlCache } from './cache.js';

const API_BASE = 'https://api.scryfall.com';

/**
 * Scryfall asks for 50-100ms between requests from a single client, a
 * descriptive User-Agent, and an explicit Accept header. This client honours
 * all three, serialises every call through one queue, and caches results.
 *
 * https://scryfall.com/docs/api
 */
const MIN_INTERVAL_MS = 110;
const MAX_PAGES = 6; // 6 * 175 = 1050 printings; far beyond any real card
const COLLECTION_CHUNK = 75; // Scryfall's documented per-request maximum

export class ScryfallError extends Error {
  constructor(message, { status = 502, details = null, code = null } = {}) {
    super(message);
    this.name = 'ScryfallError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export function createScryfallClient({
  fetchImpl = globalThis.fetch,
  cache = new TtlCache({ ttlMs: 6 * 60 * 60 * 1000 }),
  minIntervalMs = MIN_INTERVAL_MS,
  contact = globalThis.process?.env?.SCRYFALL_CONTACT || 'https://github.com/b4k4kozmo/mtgtest',
  maxRetries = 3,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }

  const headers = {
    // Scryfall rejects generic/absent user agents.
    'User-Agent': `MTGPriceFinder/1.0 (+${contact})`,
    Accept: 'application/json;q=0.9,*/*;q=0.8',
  };

  let queue = Promise.resolve();
  let lastRequestAt = 0;

  /** Serialise requests and space them out, so we stay a good API citizen. */
  function schedule(task) {
    const run = queue.then(async () => {
      const wait = lastRequestAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        lastRequestAt = Date.now();
      }
    });
    // Keep the chain alive even when a task rejects.
    queue = run.then(noop, noop);
    return run;
  }

  async function request(path, { method = 'GET', body = null, absolute = false } = {}) {
    const url = absolute ? path : `${API_BASE}${path}`;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(2 ** attempt * 250, 4000));

      let response;
      try {
        response = await schedule(() =>
          fetchImpl(url, {
            method,
            headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
          }),
        );
      } catch (err) {
        lastError = new ScryfallError(`Could not reach Scryfall: ${err.message}`, { status: 504 });
        continue;
      }

      if (response.status === 404) {
        const payload = await safeJson(response);
        throw new ScryfallError(payload?.details || 'No matching card was found.', {
          status: 404,
          details: payload?.details ?? null,
          code: payload?.code ?? 'not_found',
        });
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new ScryfallError(`Scryfall responded ${response.status}.`, { status: 503 });
        continue; // transient: retry with backoff
      }

      if (!response.ok) {
        const payload = await safeJson(response);
        throw new ScryfallError(payload?.details || `Scryfall responded ${response.status}.`, {
          status: response.status === 422 ? 400 : 502,
          details: payload?.details ?? null,
          code: payload?.code ?? null,
        });
      }

      return response.json();
    }

    throw lastError ?? new ScryfallError('Scryfall request failed.');
  }

  /** Follow `next_page` links, bounded. */
  async function paginate(firstPath) {
    const all = [];
    let page = await request(firstPath);
    all.push(...(page.data ?? []));
    let pages = 1;
    while (page.has_more && page.next_page && pages < MAX_PAGES) {
      page = await request(page.next_page, { absolute: true });
      all.push(...(page.data ?? []));
      pages += 1;
    }
    return all;
  }

  const api = {
    /** Card-name suggestions for the search box. */
    async autocomplete(query) {
      const q = String(query || '').trim();
      if (q.length < 2) return [];
      return cache.wrap(`auto:${q.toLowerCase()}`, async () => {
        const payload = await request(`/cards/autocomplete?q=${encodeURIComponent(q)}`);
        return payload.data ?? [];
      }, 24 * 60 * 60 * 1000);
    },

    /** Resolve a possibly-misspelled name to a single card. */
    async named(query, { exact = false } = {}) {
      const q = String(query || '').trim();
      if (!q) throw new ScryfallError('A card name is required.', { status: 400 });
      const key = `named:${exact ? 'e' : 'f'}:${q.toLowerCase()}`;
      return cache.wrap(key, () =>
        request(`/cards/named?${exact ? 'exact' : 'fuzzy'}=${encodeURIComponent(q)}`),
      );
    },

    async cardById(id) {
      const safeId = String(id || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(safeId)) {
        throw new ScryfallError('That card id is not valid.', { status: 400 });
      }
      return cache.wrap(`card:${safeId}`, () => request(`/cards/${safeId}`));
    },

    /**
     * Every paper printing of a card, by oracle id. Oracle id is the stable
     * identity of "the card" across reprints, so this never mixes in a
     * different card that happens to share a word in its name.
     */
    async printingsByOracleId(oracleId) {
      const id = String(oracleId || '').trim();
      if (!id) throw new ScryfallError('An oracle id is required.', { status: 400 });
      return cache.wrap(`prints:${id}`, () => {
        const params = new URLSearchParams({
          q: `oracleid:${id}`,
          unique: 'prints',
          order: 'released',
          dir: 'asc',
          include_extras: 'true',
          include_variations: 'true',
        });
        return paginate(`/cards/search?${params.toString()}`);
      }, 6 * 60 * 60 * 1000);
    },

    /** Free-text card search, used for the "did you mean" result list. */
    async searchCards(query, { unique = 'cards', order = 'name', dir = 'auto', limit = 24 } = {}) {
      const q = String(query || '').trim();
      if (!q) return [];
      const key = `search:${unique}:${order}:${dir}:${q.toLowerCase()}`;
      const results = await cache.wrap(key, async () => {
        const params = new URLSearchParams({ q, unique, order, dir });
        try {
          const page = await request(`/cards/search?${params.toString()}`);
          return page.data ?? [];
        } catch (err) {
          if (err instanceof ScryfallError && err.status === 404) return [];
          throw err;
        }
      }, 60 * 60 * 1000);
      return results.slice(0, limit);
    },

    /**
     * Printings for many cards at once.
     *
     * Batches oracle ids into a single `or` query to keep a 100-card deck down
     * to a handful of API calls. If a batch fails or comes back short (a long
     * query, an API hiccup), the missing ids fall back to one lookup each, so
     * a deck list is never silently priced from incomplete data.
     */
    async printingsByOracleIds(oracleIds, { batchSize = 8 } = {}) {
      const ids = [...new Set((oracleIds ?? []).filter(Boolean))];
      const byOracleId = new Map(ids.map((id) => [id, []]));
      const pending = [];

      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const uncached = batch.filter((id) => {
          const hit = cache.get(`prints:${id}`);
          if (hit === undefined) return true;
          byOracleId.set(id, hit);
          return false;
        });
        if (uncached.length === 0) continue;

        try {
          const params = new URLSearchParams({
            q: `(${uncached.map((id) => `oracleid:${id}`).join(' or ')})`,
            unique: 'prints',
            order: 'released',
            dir: 'asc',
            include_extras: 'true',
            include_variations: 'true',
          });
          const cards = await paginate(`/cards/search?${params.toString()}`);
          const grouped = new Map(uncached.map((id) => [id, []]));
          for (const card of cards) {
            if (grouped.has(card.oracle_id)) grouped.get(card.oracle_id).push(card);
          }
          for (const id of uncached) {
            const printings = grouped.get(id) ?? [];
            if (printings.length === 0) {
              pending.push(id);
            } else {
              cache.set(`prints:${id}`, printings, 6 * 60 * 60 * 1000);
              byOracleId.set(id, printings);
            }
          }
        } catch {
          pending.push(...uncached);
        }
      }

      for (const id of pending) {
        try {
          byOracleId.set(id, await api.printingsByOracleId(id));
        } catch {
          byOracleId.set(id, []);
        }
      }

      return byOracleId;
    },

    /**
     * The cheapest printings of many cards at once, for deck pricing.
     *
     * Deck lists are full of basic lands, which have well over a thousand
     * printings each -- walking every page of those would make pricing a deck
     * crawl. Here the query asks Scryfall for paper printings that have a
     * price, sorted cheapest first, and keeps only the first page. Since every
     * result is priced and the order is ascending, the cheapest printing of
     * each card is guaranteed to be in there.
     */
    async cheapestPrintingsByOracleIds(oracleIds, { currency = 'USD', batchSize = 8 } = {}) {
      const priceKey = currency === 'EUR' ? 'eur' : 'usd';
      const ids = [...new Set((oracleIds ?? []).filter(Boolean))];
      const byOracleId = new Map(ids.map((id) => [id, []]));
      const pending = [];

      for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);
        const uncached = batch.filter((id) => {
          const hit = cache.get(`cheap:${priceKey}:${id}`);
          if (hit === undefined) return true;
          byOracleId.set(id, hit);
          return false;
        });
        if (uncached.length === 0) continue;

        try {
          const params = new URLSearchParams({
            q: `(${uncached.map((id) => `oracleid:${id}`).join(' or ')}) game:paper ${priceKey}>=0.01`,
            unique: 'prints',
            order: priceKey,
            dir: 'asc',
            include_extras: 'true',
            include_variations: 'true',
          });
          // Deliberately one page: it already holds the cheapest printings.
          const page = await request(`/cards/search?${params.toString()}`);
          const grouped = new Map(uncached.map((id) => [id, []]));
          for (const card of page.data ?? []) {
            if (grouped.has(card.oracle_id)) grouped.get(card.oracle_id).push(card);
          }
          for (const id of uncached) {
            const printings = grouped.get(id) ?? [];
            if (printings.length === 0) {
              pending.push(id);
            } else {
              cache.set(`cheap:${priceKey}:${id}`, printings, 6 * 60 * 60 * 1000);
              byOracleId.set(id, printings);
            }
          }
        } catch {
          pending.push(...uncached);
        }
      }

      // Anything the fast path missed gets the thorough treatment.
      for (const id of pending) {
        try {
          byOracleId.set(id, await api.printingsByOracleId(id));
        } catch {
          byOracleId.set(id, []);
        }
      }

      return byOracleId;
    },

    /**
     * Bulk-resolve deck list entries. Chunked to Scryfall's 75-identifier
     * limit; returns both the found cards and the identifiers that missed.
     */
    async collection(identifiers) {
      const list = Array.isArray(identifiers) ? identifiers : [];
      const found = [];
      const notFound = [];
      for (let i = 0; i < list.length; i += COLLECTION_CHUNK) {
        const chunk = list.slice(i, i + COLLECTION_CHUNK);
        const payload = await request('/cards/collection', {
          method: 'POST',
          body: { identifiers: chunk },
        });
        found.push(...(payload.data ?? []));
        notFound.push(...(payload.not_found ?? []));
      }
      return { found, notFound };
    },

    cache,
  };

  return api;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};
