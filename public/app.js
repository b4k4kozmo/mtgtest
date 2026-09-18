/* MTG Price Finder — front end.
   Everything is built with DOM nodes rather than innerHTML: some of the text
   rendered here (marketplace listing titles) is written by strangers.

   Data access goes through ./api.js and nothing else, so this same file drives
   both the server build and the backend-free static build. */
import * as api from './api.js';

const $ = (sel) => document.querySelector(sel);

/** Tiny hyperscript helper. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const CURRENCY_SYMBOL = { USD: '$', EUR: '€' };
const money = (value, currency) => {
  if (value === null || value === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch {
    return `${CURRENCY_SYMBOL[currency] ?? ''}${Number(value).toFixed(2)}`;
  }
};

const state = {
  currency: 'USD',
  includeCollectibles: false,
  lastQuery: '',
  lastDeck: null,
  shipping: { enabled: true, perOrder: 1.29, freeOver: 5, orders: 1 },
  shippingDefaults: null,
  dealTheme: null,
};

const SHIPPING_STORAGE_KEY = 'mtg-price-finder:shipping';

/** Shipping settings a visitor edited are theirs; remember them locally. */
function loadShippingSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SHIPPING_STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') Object.assign(state.shipping, saved);
  } catch { /* private mode, blocked storage: fall back to defaults */ }
}

function saveShippingSettings() {
  try {
    localStorage.setItem(SHIPPING_STORAGE_KEY, JSON.stringify(state.shipping));
  } catch { /* nothing to do; the session still works */ }
}

/** Shipping settings as query/body parameters. */
function shippingParams() {
  return {
    shipping: String(state.shipping.enabled),
    shippingPerOrder: String(state.shipping.perOrder),
    shippingFreeOver: state.shipping.freeOver === null ? '' : String(state.shipping.freeOver),
    orders: String(state.shipping.orders),
  };
}

/* ── Tabs ──────────────────────────────────────────────────────────────── */
function activateTab(which) {
  const single = which === 'single';
  $('#tab-single').classList.toggle('is-active', single);
  $('#tab-deck').classList.toggle('is-active', !single);
  $('#tab-single').setAttribute('aria-selected', String(single));
  $('#tab-deck').setAttribute('aria-selected', String(!single));
  $('#panel-single').hidden = !single;
  $('#panel-deck').hidden = single;
}
$('#tab-single').addEventListener('click', () => activateTab('single'));
$('#tab-deck').addEventListener('click', () => activateTab('deck'));

/* ── Shared controls ───────────────────────────────────────────────────── */
$('#currency').addEventListener('change', (event) => {
  state.currency = event.target.value;
  // Each market has its own sensible shipping default, unless the visitor
  // has already set their own.
  const defaults = state.shippingDefaults?.[state.currency];
  if (defaults && !localStorage.getItem(SHIPPING_STORAGE_KEY)) {
    state.shipping.perOrder = defaults.perOrder;
    state.shipping.freeOver = defaults.freeOver ?? null;
  }
  syncShippingInputs();
  refreshAll();
  loadDeals();
});
$('#includeCollectibles').addEventListener('change', (event) => {
  state.includeCollectibles = event.target.checked;
  refreshAll();
});

const shippingInputs = {
  enabled: $('#shippingEnabled'),
  perOrder: $('#shippingPerOrder'),
  freeOver: $('#shippingFreeOver'),
  orders: $('#shippingOrders'),
};

function syncShippingInputs() {
  shippingInputs.enabled.checked = state.shipping.enabled;
  shippingInputs.perOrder.value = String(state.shipping.perOrder);
  shippingInputs.freeOver.value = state.shipping.freeOver === null ? '' : String(state.shipping.freeOver);
  shippingInputs.orders.value = String(state.shipping.orders);
  for (const key of ['perOrder', 'freeOver', 'orders']) shippingInputs[key].disabled = !state.shipping.enabled;
  $('#shipping-summary').textContent = state.shipping.enabled
    ? `Shipping: ${money(state.shipping.perOrder, state.currency)}/order`
    : 'Shipping: off';
}

function readShippingInputs() {
  const number = (input, fallback) => {
    const parsed = Number.parseFloat(input.value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  state.shipping.enabled = shippingInputs.enabled.checked;
  state.shipping.perOrder = number(shippingInputs.perOrder, 0);
  state.shipping.freeOver = shippingInputs.freeOver.value.trim() === '' ? null : number(shippingInputs.freeOver, 0);
  state.shipping.orders = Math.max(1, Math.round(number(shippingInputs.orders, 1)));
  saveShippingSettings();
  syncShippingInputs();
}

for (const input of Object.values(shippingInputs)) {
  input.addEventListener('change', () => {
    readShippingInputs();
    refreshAll();
    loadDeals();
  });
}

function refreshAll() {
  if (state.lastQuery) runSingleSearch(state.lastQuery);
  if (state.lastDeck) runDeckSearch(state.lastDeck);
}

/** Normalises whatever the transport throws into a message the UI can show. */
async function call(fn, args) {
  try {
    return await fn(args);
  } catch (err) {
    throw new Error(err?.message || 'Request failed.');
  }
}

function setStatus(target, message, { error = false, loading = false } = {}) {
  const node = $(target);
  node.replaceChildren();
  if (!message) return;
  if (error) node.append(h('div', { class: 'error', text: message }));
  else node.append(h('span', {}, loading ? h('span', { class: 'spinner' }) : null, message));
}

/* ── Autocomplete ──────────────────────────────────────────────────────── */
const queryInput = $('#card-query');
const suggestionList = $('#suggestions');
let suggestionIndex = -1;
let suggestions = [];
let autocompleteTimer = null;

queryInput.addEventListener('input', () => {
  clearTimeout(autocompleteTimer);
  const value = queryInput.value.trim();
  if (value.length < 2) return closeSuggestions();
  autocompleteTimer = setTimeout(async () => {
    try {
      const { names } = await call(api.autocomplete, { q: value });
      renderSuggestions(names);
    } catch {
      closeSuggestions();
    }
  }, 180);
});

queryInput.addEventListener('keydown', (event) => {
  if (suggestionList.hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    suggestionIndex = (suggestionIndex + delta + suggestions.length) % suggestions.length;
    highlightSuggestion();
  } else if (event.key === 'Enter' && suggestionIndex >= 0) {
    event.preventDefault();
    chooseSuggestion(suggestions[suggestionIndex]);
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});

document.addEventListener('click', (event) => {
  if (!suggestionList.contains(event.target) && event.target !== queryInput) closeSuggestions();
});

function renderSuggestions(names) {
  suggestions = names.slice(0, 10);
  suggestionIndex = -1;
  if (suggestions.length === 0) return closeSuggestions();
  suggestionList.replaceChildren(
    ...suggestions.map((name, i) =>
      h('li', {
        role: 'option',
        id: `suggestion-${i}`,
        'aria-selected': 'false',
        text: name,
        onclick: () => chooseSuggestion(name),
      }),
    ),
  );
  suggestionList.hidden = false;
  queryInput.setAttribute('aria-expanded', 'true');
}

function highlightSuggestion() {
  [...suggestionList.children].forEach((li, i) => {
    li.setAttribute('aria-selected', String(i === suggestionIndex));
  });
  if (suggestionIndex >= 0) queryInput.setAttribute('aria-activedescendant', `suggestion-${suggestionIndex}`);
}

function chooseSuggestion(name) {
  queryInput.value = name;
  closeSuggestions();
  runSingleSearch(name);
}

function closeSuggestions() {
  // Cancel any in-flight debounce, or it reopens the list after a submit.
  clearTimeout(autocompleteTimer);
  suggestionList.hidden = true;
  suggestionList.replaceChildren();
  suggestions = [];
  suggestionIndex = -1;
  queryInput.setAttribute('aria-expanded', 'false');
  queryInput.removeAttribute('aria-activedescendant');
}

/* ── Single card ───────────────────────────────────────────────────────── */
$('#single-form').addEventListener('submit', (event) => {
  event.preventDefault();
  closeSuggestions();
  const value = queryInput.value.trim();
  if (value) runSingleSearch(value);
});

async function runSingleSearch(query) {
  state.lastQuery = query;
  setStatus('#single-status', `Searching for “${query}”…`, { loading: true });
  $('#single-results').replaceChildren(skeletonHero());

  const params = {
    q: query,
    currency: state.currency,
    includeCollectibles: String(state.includeCollectibles),
    ...shippingParams(),
  };

  try {
    const data = await call(api.card, params);
    setStatus('#single-status', '');
    renderSingle(data);
    loadLiveListings(data);
  } catch (err) {
    $('#single-results').replaceChildren();
    setStatus('#single-status', err.message, { error: true });
    suggestAlternatives(query);
  }
}

async function suggestAlternatives(query) {
  try {
    const { cards } = await call(api.search, { q: query, limit: 12 });
    if (cards.length === 0) return;
    $('#single-results').replaceChildren(
      h('section', { class: 'panel' },
        h('h2', { text: 'Did you mean one of these?' }),
        h('div', { class: 'gallery' },
          cards.map((card) =>
            h('a', {
              class: 'gallery-item', href: '#',
              onclick: (e) => { e.preventDefault(); queryInput.value = card.name; runSingleSearch(card.name); },
            },
              cardImage(card, 'small'),
              h('div', { class: 'gallery-body' },
                h('span', { class: 'gallery-set', text: card.name }),
                h('span', { class: 'gallery-note', text: `${card.set} · ${card.setName ?? ''}` }),
              ),
            ),
          ),
        ),
      ),
    );
  } catch { /* the error message already shown is enough */ }
}

function renderSingle({ card, pricing, links }) {
  const { cheapest, similar, offers, excluded, counts } = pricing;
  const container = $('#single-results');
  const sections = [];

  /* Hero: card art + headline price. */
  sections.push(
    h('section', { class: 'panel' },
      h('div', { class: 'hero' },
        cardImage(card, 'large', 'hero-art'),
        h('div', { class: 'hero-meta' },
          h('h1', { text: card.name }),
          h('p', { class: 'hero-type', text: [card.typeLine, card.manaCost].filter(Boolean).join('  ·  ') }),
          cheapest ? cheapestBlock(cheapest, pricing.currency) : noPriceBlock(pricing.currency),
          h('div', { class: 'badges' },
            h('span', { class: 'badge green', text: `${counts.printingsKept} genuine printing${counts.printingsKept === 1 ? '' : 's'}` }),
            counts.printingsExcluded > 0
              ? h('span', { class: 'badge gold', text: `${counts.printingsExcluded} non-playable printing${counts.printingsExcluded === 1 ? '' : 's'} hidden` })
              : null,
            card.legalities?.commander === 'legal' ? h('span', { class: 'badge', text: 'Commander legal' }) : null,
            card.legalities?.modern === 'legal' ? h('span', { class: 'badge', text: 'Modern legal' }) : null,
          ),
        ),
      ),
    ),
  );

  /* Similarly priced printings — real card images, not stock photos. */
  if (similar.length > 1) {
    sections.push(
      h('section', { class: 'panel' },
        h('h2', { text: 'Other printings at a similar price' }),
        h('p', { class: 'panel-sub', text: 'Same card, different printing — any of these is tournament legal and interchangeable in a deck.' }),
        h('div', { class: 'gallery' },
          similar.map((offer) => printingTile(offer, pricing.currency)),
        ),
      ),
    );
  }

  /* Live marketplace listings mount point. */
  sections.push(h('section', { class: 'panel', id: 'live-listings', hidden: true }));

  /* Full price table. */
  if (offers.length > 0) {
    sections.push(
      h('section', { class: 'panel' },
        h('h2', {
          text: pricing.offersTruncated
            ? `Cheapest ${offers.length} of ${pricing.totalOffers} priced printings`
            : `Every priced printing (${offers.length})`,
        }),
        h('p', { class: 'panel-sub', text: `${priceSourceNote(pricing.currency)}${pricing.shipping ? ' Shipping shown is your estimate, applied per order.' : ''}` }),
        h('div', { class: 'table-scroll' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', { text: 'Printing' }),
              h('th', { text: 'Set' }),
              h('th', { text: 'Finish' }),
              h('th', { text: 'Rarity' }),
              h('th', { class: 'num', text: 'Price' }),
              h('th', { text: '' }),
            )),
            h('tbody', {}, offers.map((offer) => offerRow(offer, pricing.currency))),
          ),
        ),
      ),
    );
  }

  /* Reputable stores without a public price feed. */
  sections.push(
    h('section', { class: 'panel' },
      h('h2', { text: 'Check other trusted stores' }),
      h('p', { class: 'panel-sub', text: 'These sellers have no public price API, so we link straight into their catalogue instead of quoting a number we cannot verify. Marketplace searches exclude proxy, custom and altered listings.' }),
      h('div', { class: 'vendor-links' },
        links.map((link) =>
          h('a', { class: 'vendor-link', href: link.url, target: '_blank', rel: 'noopener noreferrer' },
            h('strong', { text: link.vendorName }),
            h('small', { text: link.vendorNote }),
          ),
        ),
      ),
    ),
  );

  /* Transparency about what was filtered out. */
  if (excluded.length > 0) {
    const reasons = new Map();
    for (const item of excluded) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    sections.push(
      h('section', { class: 'panel' },
        h('h3', { text: 'Hidden printings' }),
        h('div', { class: 'notice' },
          h('strong', { text: 'Only genuine, playable cards are priced.' }),
          h('ul', {}, [...reasons.entries()].map(([reason, count]) => h('li', { text: `${count} × ${reason}` }))),
        ),
      ),
    );
  }

  container.replaceChildren(...sections);
}

function cheapestBlock(offer, currency) {
  const shipped = offer.shippingIsEstimate;
  return h('div', {},
    h('p', { class: 'price-label', text: shipped ? 'Cheapest genuine listing, delivered' : 'Cheapest genuine listing' }),
    h('div', { class: 'price-headline' },
      h('span', { class: 'price-big', text: money(shipped ? offer.landedPrice : offer.price, currency) }),
      h('span', { class: 'muted', text: `on ${offer.vendorName}` }),
    ),
    shipped ? h('p', { class: 'landed' }, shippingBreakdown(offer, currency)) : null,
    h('p', { class: 'price-detail', text:
      `${offer.finishLabel} · ${offer.printing.setName} (${offer.printing.set}) #${offer.printing.collectorNumber} · ${offer.printing.rarity}` }),
    h('div', { class: 'price-actions' },
      h('a', { class: 'btn-buy', href: offer.url, target: '_blank', rel: 'noopener noreferrer', text: `Buy on ${offer.vendorName} →` }),
      h('a', { class: 'btn btn-ghost btn-small', href: offer.printing.scryfallUri, target: '_blank', rel: 'noopener noreferrer', text: 'Card details' }),
    ),
  );
}

/** "$1.20 card + $1.29 est. shipping" — always says which part is an estimate. */
function shippingBreakdown(offer, currency) {
  if (offer.shippingFree) {
    return [
      `${money(offer.price, currency)} card + `,
      h('span', { class: 'ship-free', text: 'free shipping' }),
      ' at this price',
    ];
  }
  return `${money(offer.price, currency)} card + ${money(offer.shipping, currency)} estimated shipping`;
}

function noPriceBlock(currency) {
  return h('div', { class: 'notice danger' },
    h('strong', { text: 'No current price for this card.' }),
    ` Nothing in the ${currency} market has a listed price right now — try the other market, or the store links below.`,
  );
}

function priceSourceNote(currency) {
  return currency === 'EUR'
    ? 'Cardmarket trend prices, refreshed daily via Scryfall. Click through for live seller listings.'
    : 'TCGplayer market prices, refreshed daily via Scryfall. Click through for live seller listings.';
}

function printingTile(offer, currency) {
  const p = offer.printing;
  const shipped = offer.shippingIsEstimate;
  return h('a', { class: 'gallery-item', href: offer.url, target: '_blank', rel: 'noopener noreferrer' },
    cardImage(p, 'normal'),
    h('div', { class: 'gallery-body' },
      h('span', { class: 'gallery-price', text: money(shipped ? offer.landedPrice : offer.price, currency) }),
      shipped
        ? h('span', { class: 'gallery-note' },
            offer.shippingFree
              ? h('span', { class: 'ship-free', text: 'ships free' })
              : `${money(offer.price, currency)} + shipping`)
        : null,
      h('span', { class: 'gallery-set', text: `${p.set} · #${p.collectorNumber}` }),
      h('span', { class: 'gallery-note', text: `${offer.finishLabel} · ${p.setName}` }),
    ),
  );
}

function offerRow(offer, currency) {
  const p = offer.printing;
  return h('tr', {},
    h('td', {}, h('div', { class: 'cell-card' },
      cardImage(p, 'small', 'thumb'),
      h('div', {},
        h('div', { class: 'cell-card-name', text: p.name }),
        h('div', { class: 'cell-card-sub', text: `#${p.collectorNumber}${p.promo ? ' · promo' : ''}${p.fullArt ? ' · full art' : ''}` }),
      ),
    )),
    h('td', {}, h('div', {}, h('div', { text: p.setName }), h('div', { class: 'cell-card-sub', text: `${p.set} · ${p.releasedAt ?? ''}` }))),
    h('td', { text: offer.finishLabel }),
    h('td', { text: p.rarity ?? '' }),
    h('td', { class: 'num price' },
      money(offer.shippingIsEstimate ? offer.landedPrice : offer.price, currency),
      offer.shippingIsEstimate
        ? h('span', { class: `landed${offer.shippingFree ? ' ship-free' : ''}`,
            text: offer.shippingFree ? 'ships free' : `${money(offer.price, currency)} + ship` })
        : null,
    ),
    h('td', {}, h('a', { class: 'btn btn-ghost btn-small', href: offer.url, target: '_blank', rel: 'noopener noreferrer', text: offer.vendorName })),
  );
}

function cardImage(card, size = 'normal', className = '') {
  const src = card.images?.[size] ?? card.images?.normal ?? card.images?.small ?? null;
  const img = h('img', {
    class: className,
    alt: `${card.name}${card.setName ? ` — ${card.setName}` : ''}`,
    loading: 'lazy',
    decoding: 'async',
  });
  if (src) img.src = src;
  return img;
}

function skeletonHero() {
  return h('section', { class: 'panel' },
    h('div', { class: 'hero' },
      h('div', { class: 'skeleton hero-art' }),
      h('div', {},
        h('div', { class: 'skeleton', style: 'height:2rem;width:60%;margin-bottom:.8rem' }),
        h('div', { class: 'skeleton', style: 'height:1rem;width:40%;margin-bottom:1.6rem' }),
        h('div', { class: 'skeleton', style: 'height:3rem;width:50%' }),
      ),
    ),
  );
}

/* ── Live marketplace listings (eBay, when credentials are configured) ──── */
async function loadLiveListings({ card, liveListings }) {
  const mount = document.getElementById('live-listings');
  if (!mount || !liveListings?.ebay) return;
  try {
    const { listings, error } = await call(api.listings, { name: card.name, limit: 8 });
    if (error || listings.length === 0) return;
    mount.replaceChildren(
      h('h2', { text: 'Live eBay listings near the cheapest price' }),
      h('p', { class: 'panel-sub', text: 'Seller photos, fixed-price only, sorted by price plus shipping. Listings mentioning proxies, replicas, alters or custom cards are filtered out, and low-feedback sellers are excluded.' }),
      h('div', { class: 'gallery' }, listings.map((listing) => listingTile(listing))),
    );
    mount.hidden = false;
  } catch { /* live listings are a bonus; never block the page */ }
}

function listingTile(listing) {
  const img = h('img', { alt: listing.title, loading: 'lazy', decoding: 'async' });
  if (listing.imageUrl) img.src = listing.imageUrl;
  const feedback = Number.isFinite(listing.seller.feedbackPercent)
    ? `${listing.seller.feedbackPercent}% positive`
    : 'seller rating unavailable';
  return h('a', { class: 'gallery-item listing', href: listing.url, target: '_blank', rel: 'noopener noreferrer' },
    img,
    h('div', { class: 'gallery-body' },
      h('span', { class: 'gallery-price', text: money(listing.totalPrice, listing.currency) }),
      h('span', { class: 'gallery-note', text: listing.shipping > 0 ? `incl. ${money(listing.shipping, listing.currency)} shipping` : 'free shipping' }),
      h('span', { class: 'gallery-title', text: listing.title }),
      h('span', { class: 'gallery-note', text: `${listing.condition ?? 'Condition not stated'} · ${feedback}` }),
    ),
  );
}

/* ── Deck list ─────────────────────────────────────────────────────────── */
const SAMPLE_DECK = `// Modern Burn — example list
Deck
4 Goblin Guide
4 Monastery Swiftspear
4 Lightning Bolt
4 Lava Spike
4 Boros Charm
4 Skewer the Critics
2 Fire // Ice
4 Inspiring Vantage
4 Sacred Foundry
6 Mountain

Sideboard
2 Pyroblast
3 Path to Exile`;

$('#deck-sample').addEventListener('click', () => { $('#deck-input').value = SAMPLE_DECK; });
$('#deck-clear').addEventListener('click', () => {
  $('#deck-input').value = '';
  $('#deck-results').replaceChildren();
  setStatus('#deck-status', '');
  state.lastDeck = null;
});
$('#deck-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $('#deck-input').value = await file.text();
  event.target.value = '';
});

$('#deck-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const list = $('#deck-input').value;
  if (list.trim()) runDeckSearch(list);
});

async function runDeckSearch(list) {
  state.lastDeck = list;
  setStatus('#deck-status', 'Looking up every card and finding the cheapest genuine printing…', { loading: true });
  $('#deck-results').replaceChildren();
  try {
    const data = await call(api.deck, {
      list,
      currency: state.currency,
      includeCollectibles: state.includeCollectibles,
      ...shippingParams(),
      shipping: state.shipping.enabled,
    });
    setStatus('#deck-status', '');
    renderDeck(data);
  } catch (err) {
    setStatus('#deck-status', err.message, { error: true });
  }
}

function renderDeck(data) {
  const { totals, cards, missing, parse, currency } = data;
  const sections = [];

  sections.push(
    h('section', { class: 'panel' },
      h('h2', { text: 'Deck total at the cheapest genuine printing of each card' }),
      h('p', { class: 'panel-sub', text: priceSourceNote(currency) }),
      h('dl', { class: 'summary-grid' },
        summaryCard(totals.shipping ? 'Total delivered' : 'Cheapest total', money(totals.total, currency), 'total'),
        totals.shipping ? summaryCard('Cards subtotal', money(totals.cardsSubtotal, currency)) : null,
        totals.shipping ? summaryCard('Shipping (est.)', money(totals.shipping.estimate, currency), totals.shipping.estimate > 0 ? 'warn' : '') : null,
        summaryCard('Cards', String(totals.cardCount)),
        summaryCard('Distinct cards', String(totals.distinctCards)),
        totals.unpricedCards > 0 ? summaryCard('Unpriced', String(totals.unpricedCards), 'warn') : null,
        missing.length > 0 ? summaryCard('Not found', String(missing.length), 'warn') : null,
      ),
      totals.shipping ? h('p', { class: 'muted', text: shippingExplanation(totals.shipping, currency) }) : null,
      totals.bySection.length > 1
        ? h('p', { class: 'muted', text: totals.bySection.map((s) => `${s.section}: ${money(s.total, currency)} (${s.cards} cards)`).join('  ·  ') })
        : null,
      h('div', { class: 'deck-actions' },
        h('a', {
          class: 'btn-buy',
          href: tcgMassEntryUrl(cards),
          target: '_blank',
          rel: 'noopener noreferrer',
          text: 'Open in TCGplayer Mass Entry →',
        }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Copy list for any store', onclick: (e) => copyList(cards, e.target) }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Download CSV', onclick: () => downloadCsv(cards, currency) }),
      ),
    ),
  );

  if (missing.length > 0 || parse.errors.length > 0) {
    sections.push(
      h('section', { class: 'panel' },
        h('h3', { text: 'Lines we could not price' }),
        h('div', { class: 'notice danger' },
          h('ul', {},
            missing.map((item) => h('li', { text: `${item.line} — ${item.reason}` })),
            parse.errors.map((item) => h('li', { text: `Line ${item.lineNumber}: ${item.message}` })),
          ),
        ),
      ),
    );
  }

  const bySection = new Map();
  for (const card of cards) {
    if (!bySection.has(card.section)) bySection.set(card.section, []);
    bySection.get(card.section).push(card);
  }

  for (const [section, sectionCards] of bySection) {
    sections.push(
      h('section', { class: 'panel' },
        h('h2', { text: `${sectionLabel(section)} — ${sectionCards.reduce((n, c) => n + c.quantity, 0)} cards` }),
        h('div', { class: 'table-scroll' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', { class: 'num', text: 'Qty' }),
              h('th', { text: 'Card' }),
              h('th', { text: 'Cheapest printing' }),
              h('th', { class: 'num', text: 'Each' }),
              h('th', { class: 'num', text: 'Total' }),
              h('th', { text: 'Buy' }),
            )),
            h('tbody', {}, sectionCards.map((card) => deckRow(card, currency))),
          ),
        ),
      ),
    );
  }

  // One block per distinct card: a card in both the main deck and the
  // sideboard must not show its alternatives twice.
  const seenOracleIds = new Set();
  const withAlternatives = cards
    .filter((card) => {
      if (card.alternatives.length === 0) return false;
      const key = card.oracleId ?? card.name;
      if (seenOracleIds.has(key)) return false;
      seenOracleIds.add(key);
      return true;
    })
    .slice(0, 6);
  if (withAlternatives.length > 0) {
    sections.push(
      h('section', { class: 'panel' },
        h('h2', { text: 'Similarly priced alternative printings' }),
        h('p', { class: 'panel-sub', text: 'If the cheapest printing is out of stock, these cost about the same and play identically.' }),
        ...withAlternatives.map((card) =>
          h('div', { style: 'margin-bottom:1.1rem' },
            h('h3', { text: card.name }),
            h('div', { class: 'gallery' }, card.alternatives.map((offer) => printingTile(offer, currency))),
          ),
        ),
      ),
    );
  }

  $('#deck-results').replaceChildren(...sections);
}

/** Spell out exactly how the shipping estimate was reached. */
function shippingExplanation(shipping, currency) {
  const orders = shipping.orders ?? 1;
  const perOrder = money(shipping.perOrder, currency);
  const split = orders === 1 ? 'one order' : `${orders} separate orders`;
  if (shipping.estimate === 0 && shipping.freeOver !== null) {
    return `Estimated as ${split} at ${perOrder} each — waived here because each order clears the ${money(shipping.freeOver, currency)} free-shipping threshold. Change it under Shipping.`;
  }
  const threshold = shipping.freeOver !== null ? `, free over ${money(shipping.freeOver, currency)} per order` : '';
  return `Estimated as ${split} at ${perOrder} each${threshold}. A real deck order usually spans a few sellers — raise "separate orders" under Shipping to match. eBay listings use their own real shipping cost.`;
}

function summaryCard(label, value, variant = '') {
  return h('div', { class: `summary-card ${variant}`.trim() },
    h('dt', { text: label }),
    h('dd', { text: value }),
  );
}

function sectionLabel(section) {
  const labels = { main: 'Main deck', sideboard: 'Sideboard', commander: 'Commander', companion: 'Companion', maybeboard: 'Maybeboard', tokens: 'Tokens' };
  return labels[section] ?? section;
}

function deckRow(card, currency) {
  const offer = card.cheapest;
  return h('tr', {},
    h('td', { class: 'num', text: String(card.quantity) }),
    h('td', {}, h('div', { class: 'cell-card' },
      cardImage(card, 'small', 'thumb'),
      h('div', {},
        h('div', { class: 'cell-card-name', text: card.name }),
        card.requested.set
          ? h('div', { class: 'cell-card-sub', text: `you asked for ${card.requested.set.toUpperCase()} ${card.requested.collectorNumber ?? ''}`.trim() })
          : null,
        card.finishRelaxed
          ? h('div', { class: 'cell-card-sub', text: `no ${card.requested.finish} price available — showing the cheapest finish` })
          : null,
      ),
    )),
    h('td', {}, offer
      ? h('div', {},
          h('div', { text: `${offer.printing.setName} (${offer.printing.set})` }),
          h('div', { class: 'cell-card-sub', text: `#${offer.printing.collectorNumber} · ${offer.finishLabel} · ${offer.printing.rarity}` }))
      : h('span', { class: 'muted', text: 'no current price' })),
    h('td', { class: 'num price', text: money(card.unitPrice, currency) }),
    h('td', { class: 'num price', text: money(card.lineTotal, currency) }),
    h('td', {}, offer
      ? h('a', { class: 'btn btn-ghost btn-small', href: offer.url, target: '_blank', rel: 'noopener noreferrer', text: offer.vendorName })
      : h('a', { class: 'btn btn-ghost btn-small', href: card.links[0]?.url ?? card.scryfallUri, target: '_blank', rel: 'noopener noreferrer', text: 'Search' })),
  );
}

/** Plain "4 Lightning Bolt" text — what every store's bulk-entry box wants. */
function plainList(cards) {
  return cards.map((card) => `${card.quantity} ${card.name}`).join('\n');
}

function tcgMassEntryUrl(cards) {
  const base = 'https://www.tcgplayer.com/massentry?productline=Magic&c=';
  let list = plainList(cards);
  // Keep the URL inside what browsers and the target page handle comfortably.
  while (encodeURIComponent(list).length > 7000 && list.includes('\n')) {
    list = list.slice(0, list.lastIndexOf('\n'));
  }
  return base + encodeURIComponent(list);
}

async function copyList(cards, button) {
  const text = plainList(cards);
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'Copied ✓';
    setTimeout(() => { button.textContent = original; }, 1800);
  } catch {
    window.prompt('Copy this deck list:', text);
  }
}

function downloadCsv(cards, currency) {
  const header = ['Quantity', 'Card', 'Set', 'Set code', 'Collector number', 'Finish', 'Vendor', `Unit price (${currency})`, `Line total (${currency})`, 'Buy URL'];
  const rows = cards.map((card) => [
    card.quantity,
    card.name,
    card.cheapest?.printing.setName ?? '',
    card.cheapest?.printing.set ?? '',
    card.cheapest?.printing.collectorNumber ?? '',
    card.cheapest?.finishLabel ?? '',
    card.cheapest?.vendorName ?? '',
    card.unitPrice ?? '',
    card.lineTotal ?? '',
    card.cheapest?.url ?? '',
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = h('a', { href: url, download: 'mtg-deck-prices.csv' });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ── Good deals ────────────────────────────────────────────────────────── */
const dealsSection = $('#deals');
const dealsTrack = $('#deals-track');

$('#deals-refresh').addEventListener('click', () => loadDeals({ reshuffle: true }));

async function loadDeals({ reshuffle = false } = {}) {
  const params = {
    currency: state.currency,
    includeCollectibles: String(state.includeCollectibles),
    limit: '16',
    ...shippingParams(),
  };
  // Keep the same theme when only a setting changed; pick a new one on Shuffle.
  if (state.dealTheme && !reshuffle) params.theme = state.dealTheme;

  try {
    const { theme, deals } = await call(api.deals, params);
    if (!deals || deals.length === 0) {
      dealsSection.hidden = true;
      return;
    }
    state.dealTheme = theme.id;
    $('#deals-title').textContent = theme.label;
    $('#deals-blurb').textContent = theme.blurb;
    renderDeals(deals);
    dealsSection.hidden = false;
  } catch {
    // A deals outage is not worth an error message; the rest of the page works.
    dealsSection.hidden = true;
  }
}

function renderDeals(deals) {
  const tiles = deals.map((deal) => dealTile(deal));
  // A second copy makes the loop seamless; it is hidden from assistive tech
  // and from the reduced-motion layout.
  const clones = deals.map((deal) => {
    const clone = dealTile(deal);
    clone.dataset.clone = 'true';
    clone.setAttribute('aria-hidden', 'true');
    for (const node of clone.querySelectorAll('button, a')) node.setAttribute('tabindex', '-1');
    return clone;
  });
  dealsTrack.replaceChildren(...tiles, ...clones);
  // Roughly constant speed regardless of how many tiles there are.
  dealsTrack.style.setProperty('--marquee-duration', `${Math.max(30, deals.length * 5)}s`);
}

function dealTile(deal) {
  const offer = deal.offer;
  const shipped = offer.shippingIsEstimate;
  const img = h('img', { alt: `${deal.name} — ${offer.printing.setName}`, loading: 'lazy', decoding: 'async' });
  const src = deal.images?.normal ?? deal.images?.small;
  if (src) img.src = src;

  return h('article', { class: 'deal-tile' },
    img,
    h('div', { class: 'deal-body' },
      h('span', { class: 'deal-price', text: money(shipped ? offer.landedPrice : offer.price, deal.offer.currency) }),
      shipped && !offer.shippingFree
        ? h('span', { class: 'deal-meta', text: `${money(offer.price, offer.currency)} + shipping` })
        : shipped
          ? h('span', { class: 'deal-meta ship-free', text: 'ships free' })
          : null,
      h('span', { class: 'deal-name', text: deal.name }),
      h('span', { class: 'deal-meta', text: `${offer.printing.set} · ${offer.finishLabel}` }),
      deal.savingsPercent
        ? h('span', { class: 'deal-save', text: `${deal.savingsPercent}% under the ${money(deal.dearestPrice, offer.currency)} printing` })
        : null,
      h('div', { class: 'deal-actions' },
        h('button', {
          class: 'btn-link', type: 'button', text: 'Compare',
          onclick: () => {
            activateTab('single');
            queryInput.value = deal.name;
            runSingleSearch(deal.name);
            document.getElementById('single-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        }),
        h('a', {
          class: 'btn-link', href: offer.url, target: '_blank', rel: 'noopener noreferrer',
          title: `Buy on ${offer.vendorName}`, text: 'Buy →',
        }),
      ),
    ),
  );
}

/* ── Boot ──────────────────────────────────────────────────────────────── */
(async function boot() {
  loadShippingSettings();
  syncShippingInputs();
  try {
    const health = await call(api.health, undefined);
    state.shippingDefaults = health.shipping ?? null;
    const ebay = health.liveListings?.ebay
      ? 'Live eBay listings enabled.'
      : 'Live eBay listings are off — add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to show real listing photos and prices.';
    $('#footer-status').textContent = `Price source: ${health.priceSource}. ${ebay}`;
  } catch {
    $('#footer-status').textContent = '';
  }
  loadDeals();
  queryInput.focus();
})();
