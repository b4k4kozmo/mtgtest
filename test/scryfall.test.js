import test from 'node:test';
import assert from 'node:assert/strict';
import { createScryfallClient, ScryfallError } from '../server/lib/scryfall.js';
import { TtlCache } from '../server/lib/cache.js';

/** Minimal fetch double that records calls and replays queued responses. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(url, options);
    return jsonResponse(next.status ?? 200, next.body ?? {});
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const card = (overrides = {}) => ({ object: 'card', id: 'x', oracle_id: 'o1', name: 'Test', ...overrides });

test('requests carry the headers Scryfall requires', async () => {
  const fetchImpl = fakeFetch([{ body: card() }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0, contact: 'https://example.test' });
  await client.named('Test');

  const { options } = fetchImpl.calls[0];
  assert.match(options.headers['User-Agent'], /^MTGPriceFinder\/1\.0 \(\+https:\/\/example\.test\)$/);
  assert.match(options.headers.Accept, /application\/json/);
});

test('requests are spaced out to respect the rate limit', async () => {
  const fetchImpl = fakeFetch([{ body: { object: 'catalog', data: [] } }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 40 });
  const started = Date.now();
  await Promise.all([client.autocomplete('aaa'), client.autocomplete('bbb'), client.autocomplete('ccc')]);
  assert.ok(Date.now() - started >= 80, 'three calls must take at least two intervals');
});

test('a 429 is retried and then succeeds', async () => {
  let attempt = 0;
  const fetchImpl = fakeFetch([
    () => {
      attempt += 1;
      return attempt === 1 ? jsonResponse(429, {}) : jsonResponse(200, card({ name: 'Bolt' }));
    },
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const result = await client.named('Bolt');
  assert.equal(result.name, 'Bolt');
  assert.equal(attempt, 2);
});

test('a 5xx is retried, then gives up with a 503', async () => {
  const fetchImpl = fakeFetch([{ status: 503, body: {} }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0, maxRetries: 1 });
  await assert.rejects(() => client.named('Bolt'), (err) => {
    assert.ok(err instanceof ScryfallError);
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2, 'initial attempt plus one retry');
});

test('a 404 is surfaced immediately, not retried', async () => {
  const fetchImpl = fakeFetch([{ status: 404, body: { object: 'error', code: 'not_found', details: 'No card found.' } }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await assert.rejects(() => client.named('Zzzz'), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.details, 'No card found.');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);
});

test('an invalid search is reported as a client error', async () => {
  const fetchImpl = fakeFetch([{ status: 422, body: { object: 'error', details: 'Bad query.' } }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await assert.rejects(() => client.named('!!'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('paginated searches follow next_page', async () => {
  let page = 0;
  const fetchImpl = fakeFetch([
    () => {
      page += 1;
      return page === 1
        ? jsonResponse(200, { data: [card({ id: 'a' })], has_more: true, next_page: 'https://api.scryfall.com/next' })
        : jsonResponse(200, { data: [card({ id: 'b' })], has_more: false });
    },
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const printings = await client.printingsByOracleId('o1');
  assert.deepEqual(printings.map((c) => c.id), ['a', 'b']);
  assert.equal(fetchImpl.calls[1].url, 'https://api.scryfall.com/next');
});

test('results are cached, so a repeat lookup makes no second request', async () => {
  const fetchImpl = fakeFetch([{ body: card({ name: 'Bolt' }) }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await client.named('Bolt');
  await client.named('bolt');
  assert.equal(fetchImpl.calls.length, 1);
});

test('a failed request is not cached', async () => {
  let attempt = 0;
  const fetchImpl = fakeFetch([
    () => {
      attempt += 1;
      return attempt <= 2 ? jsonResponse(404, { details: 'nope' }) : jsonResponse(200, card());
    },
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await assert.rejects(() => client.named('Ghost'));
  await assert.rejects(() => client.named('Ghost'));
  assert.equal(attempt, 2, 'the second call really hit the API again');
});

test('collection requests are chunked to Scryfall’s 75-identifier limit', async () => {
  const fetchImpl = fakeFetch([() => jsonResponse(200, { data: [card()], not_found: [] })]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const identifiers = Array.from({ length: 160 }, (_, i) => ({ name: `Card ${i}` }));
  await client.collection(identifiers);

  assert.equal(fetchImpl.calls.length, 3, '160 identifiers = 75 + 75 + 10');
  const sizes = fetchImpl.calls.map((call) => JSON.parse(call.options.body).identifiers.length);
  assert.deepEqual(sizes, [75, 75, 10]);
});

test('oracle ids are batched into one search', async () => {
  const fetchImpl = fakeFetch([
    () => jsonResponse(200, {
      data: [card({ id: 'a', oracle_id: 'o1' }), card({ id: 'b', oracle_id: 'o2' })],
      has_more: false,
    }),
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const result = await client.printingsByOracleIds(['o1', 'o2']);

  assert.equal(fetchImpl.calls.length, 1);
  const query = new URL(fetchImpl.calls[0].url).searchParams;
  assert.equal(query.get('q'), '(oracleid:o1 or oracleid:o2)');
  assert.equal(query.get('unique'), 'prints');
  assert.deepEqual(result.get('o1').map((c) => c.id), ['a']);
  assert.deepEqual(result.get('o2').map((c) => c.id), ['b']);
});

test('an id missing from a batch falls back to an individual lookup', async () => {
  let call = 0;
  const fetchImpl = fakeFetch([
    () => {
      call += 1;
      // The batch only returns o1; o2 must be fetched on its own.
      if (call === 1) return jsonResponse(200, { data: [card({ id: 'a', oracle_id: 'o1' })], has_more: false });
      return jsonResponse(200, { data: [card({ id: 'b', oracle_id: 'o2' })], has_more: false });
    },
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const result = await client.printingsByOracleIds(['o1', 'o2']);

  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(result.get('o2').map((c) => c.id), ['b']);
});

test('a failed batch falls back rather than losing every card', async () => {
  let call = 0;
  const fetchImpl = fakeFetch([
    () => {
      call += 1;
      if (call === 1) return jsonResponse(500, {});
      return jsonResponse(200, { data: [card({ id: 'a', oracle_id: 'o1' })], has_more: false });
    },
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0, maxRetries: 0 });
  const result = await client.printingsByOracleIds(['o1']);
  assert.deepEqual(result.get('o1').map((c) => c.id), ['a']);
});

test('a batch reuses already-cached printings', async () => {
  const cache = new TtlCache();
  cache.set('prints:o1', [card({ id: 'cached', oracle_id: 'o1' })]);
  const fetchImpl = fakeFetch([() => jsonResponse(200, { data: [], has_more: false })]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0, cache });

  const result = await client.printingsByOracleIds(['o1']);
  assert.equal(fetchImpl.calls.length, 0, 'nothing left to fetch');
  assert.deepEqual(result.get('o1').map((c) => c.id), ['cached']);
});

test('card ids are validated before they reach the API', async () => {
  const fetchImpl = fakeFetch([{ body: card() }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await assert.rejects(() => client.cardById('../../etc/passwd'), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('short autocomplete queries never hit the API', async () => {
  const fetchImpl = fakeFetch([{ body: { data: [] } }]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  assert.deepEqual(await client.autocomplete('a'), []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('deck lookups ask only for priced paper printings, cheapest first', async () => {
  const fetchImpl = fakeFetch([
    () => jsonResponse(200, {
      data: [card({ id: 'cheap', oracle_id: 'o1' }), card({ id: 'dearer', oracle_id: 'o1' })],
      has_more: true,
      next_page: 'https://api.scryfall.com/next',
    }),
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const result = await client.cheapestPrintingsByOracleIds(['o1']);

  const query = new URL(fetchImpl.calls[0].url).searchParams;
  assert.equal(query.get('q'), '(oracleid:o1) game:paper usd>=0.01');
  assert.equal(query.get('order'), 'usd');
  assert.equal(query.get('dir'), 'asc');
  // One page only: a basic land must not drag six round trips into a deck price.
  assert.equal(fetchImpl.calls.length, 1, 'next_page is deliberately not followed');
  assert.deepEqual(result.get('o1').map((c) => c.id), ['cheap', 'dearer']);
});

test('deck lookups switch price field with the currency', async () => {
  const fetchImpl = fakeFetch([() => jsonResponse(200, { data: [card({ oracle_id: 'o1' })] })]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await client.cheapestPrintingsByOracleIds(['o1'], { currency: 'EUR' });

  const query = new URL(fetchImpl.calls[0].url).searchParams;
  assert.equal(query.get('q'), '(oracleid:o1) game:paper eur>=0.01');
  assert.equal(query.get('order'), 'eur');
});

test('a card missing from the cheap page falls back to its full print run', async () => {
  let call = 0;
  const fetchImpl = fakeFetch([
    () => {
      call += 1;
      if (call === 1) return jsonResponse(200, { data: [] });
      return jsonResponse(200, { data: [card({ id: 'full', oracle_id: 'o1' })], has_more: false });
    },
  ]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  const result = await client.cheapestPrintingsByOracleIds(['o1']);
  assert.deepEqual(result.get('o1').map((c) => c.id), ['full']);
});

test('USD and EUR deck lookups do not share a cache entry', async () => {
  const fetchImpl = fakeFetch([() => jsonResponse(200, { data: [card({ oracle_id: 'o1' })] })]);
  const client = createScryfallClient({ fetchImpl, minIntervalMs: 0 });
  await client.cheapestPrintingsByOracleIds(['o1'], { currency: 'USD' });
  await client.cheapestPrintingsByOracleIds(['o1'], { currency: 'EUR' });
  await client.cheapestPrintingsByOracleIds(['o1'], { currency: 'USD' });
  assert.equal(fetchImpl.calls.length, 2, 'one request per currency, then cached');
});
