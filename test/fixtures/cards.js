/**
 * Scryfall-shaped fixtures.
 *
 * Field names and value shapes mirror the real `card` object documented at
 * https://scryfall.com/docs/api/cards so the tests exercise the same parsing
 * paths as production traffic.
 */

const BOLT_ORACLE = 'ee5a0de6-cd3a-4b0f-9c0d-3e0f61f99cba';

export function makePrinting(overrides = {}) {
  const set = overrides.set ?? 'm10';
  const collector = overrides.collector_number ?? '146';
  return {
    object: 'card',
    id: overrides.id ?? `id-${set}-${collector}`,
    oracle_id: BOLT_ORACLE,
    name: 'Lightning Bolt',
    lang: 'en',
    released_at: '2009-07-17',
    layout: 'normal',
    type_line: 'Instant',
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    mana_cost: '{R}',
    rarity: 'common',
    set,
    set_name: 'Magic 2010',
    set_type: 'core',
    collector_number: collector,
    digital: false,
    games: ['paper'],
    finishes: ['nonfoil', 'foil'],
    oversized: false,
    promo: false,
    border_color: 'black',
    artist: 'Christopher Moeller',
    full_art: false,
    frame_effects: [],
    legalities: { modern: 'legal', commander: 'legal', standard: 'not_legal' },
    image_uris: {
      small: `https://cards.scryfall.io/small/front/${set}.jpg`,
      normal: `https://cards.scryfall.io/normal/front/${set}.jpg`,
      large: `https://cards.scryfall.io/large/front/${set}.jpg`,
      art_crop: `https://cards.scryfall.io/art_crop/front/${set}.jpg`,
    },
    prices: { usd: '2.50', usd_foil: '18.00', usd_etched: null, eur: '1.90', eur_foil: '14.00', tix: '0.03' },
    purchase_uris: {
      tcgplayer: `https://www.tcgplayer.com/product/${set}`,
      cardmarket: `https://www.cardmarket.com/en/Magic/Products/${set}`,
      cardhoarder: `https://www.cardhoarder.com/cards/${set}`,
    },
    scryfall_uri: `https://scryfall.com/card/${set}/${collector}/lightning-bolt`,
    ...overrides,
  };
}

/** A realistic spread: cheap reprints, an expensive original, and junk we must hide. */
export const boltPrintings = [
  makePrinting({ id: 'p-lea', set: 'lea', set_name: 'Limited Edition Alpha', collector_number: '161', released_at: '1993-08-05', finishes: ['nonfoil'], prices: price({ usd: '1400.00' }) }),
  makePrinting({ id: 'p-m10', set: 'm10', collector_number: '146', prices: price({ usd: '2.50', usd_foil: '18.00', eur: '1.90' }) }),
  makePrinting({ id: 'p-a25', set: 'a25', set_name: 'Masters 25', collector_number: '141', released_at: '2018-03-16', prices: price({ usd: '1.85', usd_foil: '9.50', eur: '1.40' }) }),
  makePrinting({ id: 'p-clb', set: 'clb', set_name: "Battle for Baldur's Gate", collector_number: '187', released_at: '2022-06-10', prices: price({ usd: '1.20', usd_foil: '3.10', eur: '0.95' }) }),
  makePrinting({ id: 'p-2xm', set: '2xm', set_name: 'Double Masters', collector_number: '129', released_at: '2020-08-07', prices: price({ usd: '1.35', usd_foil: '4.00', eur: '1.05' }) }),
  // Must be hidden: gold-bordered collector product.
  makePrinting({ id: 'p-ced', set: 'ced', set_name: "Collectors' Edition", set_type: 'memorabilia', collector_number: '161', border_color: 'gold', finishes: ['nonfoil'], prices: price({ usd: '0.35' }) }),
  // Must be hidden: 30th Anniversary Edition (non-standard card back).
  makePrinting({ id: 'p-30a', set: '30a', set_name: '30th Anniversary Edition', set_type: 'memorabilia', collector_number: '161', finishes: ['nonfoil'], prices: price({ usd: '0.50' }) }),
  // Must be hidden: digital-only Arena printing.
  makePrinting({ id: 'p-ana', set: 'ana', set_name: 'Arena New Player Experience', digital: true, games: ['arena'], collector_number: '42', prices: price({ usd: '0.01' }) }),
  // Must be hidden: oversized display card.
  makePrinting({ id: 'p-big', set: 'ovnt', set_name: 'Oversize Cards', oversized: true, collector_number: '3', finishes: ['nonfoil'], prices: price({ usd: '0.10' }) }),
];

function price(overrides) {
  return { usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null, eur_etched: null, tix: null, ...overrides };
}

/** A modal double-faced card: art lives on `card_faces`, not the top level. */
export const dfcCard = {
  object: 'card',
  id: 'dfc-1',
  oracle_id: 'dfc-oracle',
  name: 'Agadeem’s Awakening // Agadeem, the Undercrypt',
  layout: 'modal_dfc',
  set: 'znr',
  set_name: 'Zendikar Rising',
  set_type: 'expansion',
  collector_number: '90',
  rarity: 'mythic',
  released_at: '2020-09-25',
  digital: false,
  games: ['paper', 'arena', 'mtgo'],
  finishes: ['nonfoil', 'foil'],
  border_color: 'black',
  card_faces: [
    {
      name: 'Agadeem’s Awakening',
      type_line: 'Sorcery',
      mana_cost: '{X}{B}{B}{B}',
      oracle_text: 'Return from your graveyard to the battlefield...',
      image_uris: {
        small: 'https://cards.scryfall.io/small/front/dfc.jpg',
        normal: 'https://cards.scryfall.io/normal/front/dfc.jpg',
        large: 'https://cards.scryfall.io/large/front/dfc.jpg',
        art_crop: 'https://cards.scryfall.io/art_crop/front/dfc.jpg',
      },
    },
    { name: 'Agadeem, the Undercrypt', type_line: 'Land', oracle_text: 'As this land enters...' },
  ],
  prices: price({ usd: '14.99', usd_foil: '21.00', eur: '12.00' }),
  purchase_uris: { tcgplayer: 'https://www.tcgplayer.com/product/znr-90', cardmarket: 'https://www.cardmarket.com/znr-90' },
  scryfall_uri: 'https://scryfall.com/card/znr/90',
};

/** A split card, to prove "Fire // Ice" survives parsing and name lookup. */
export const splitCard = {
  object: 'card',
  id: 'split-1',
  oracle_id: 'split-oracle',
  name: 'Fire // Ice',
  layout: 'split',
  set: 'apc',
  set_name: 'Apocalypse',
  set_type: 'expansion',
  collector_number: '128',
  rarity: 'uncommon',
  released_at: '2001-06-01',
  digital: false,
  games: ['paper'],
  finishes: ['nonfoil', 'foil'],
  border_color: 'black',
  type_line: 'Instant // Instant',
  image_uris: {
    small: 'https://cards.scryfall.io/small/front/split.jpg',
    normal: 'https://cards.scryfall.io/normal/front/split.jpg',
    large: 'https://cards.scryfall.io/large/front/split.jpg',
    art_crop: 'https://cards.scryfall.io/art_crop/front/split.jpg',
  },
  card_faces: [{ name: 'Fire' }, { name: 'Ice' }],
  prices: price({ usd: '0.75', usd_foil: '6.00', eur: '0.60' }),
  purchase_uris: { tcgplayer: 'https://www.tcgplayer.com/product/apc-128', cardmarket: 'https://www.cardmarket.com/apc-128' },
  scryfall_uri: 'https://scryfall.com/card/apc/128',
};
