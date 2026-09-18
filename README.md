# MTG Price Finder

Search any *Magic: The Gathering* card — or paste a whole deck list — and get the
cheapest **genuine** listing from reputable vendors, with card images and
similarly priced alternatives.

No proxies. No counterfeits. No custom cards.

---

## What it does

**Good deals strip**
- A scrolling shelf of cards people actually play that are cheap right now,
  rotating between Commander, Modern, Pauper, Legacy and cheap-mythic themes.
- Where a card has a much pricier printing, the gap is shown — "99% under the
  $1,400.00 printing" — measured from real prices, comparing like finish with
  like finish.

**Single card**
- Fuzzy search with autocomplete (misspellings are fine).
- The cheapest genuine printing, with a direct buy link.
- A gallery of **other printings at a similar price**, each with its real card image.
- Live eBay listings with the seller's own photo, when eBay credentials are configured.
- A full table of every priced printing, sortable by what you care about.
- Deep links into Card Kingdom, Star City Games and CoolStuffInc.

**Deck list**
- Paste or upload a list; get the cheapest genuine printing of every card and a deck total.
- Main deck / sideboard / commander / maybeboard are tracked separately.
- One-click **TCGplayer Mass Entry**, clipboard copy for any other store, and CSV export.
- Anything that could not be resolved is listed explicitly — no card silently disappears.

**Shipping**
- Prices are shown delivered, not as a sticker price you cannot actually pay.
- Free-shipping thresholds are respected, and they can change the answer: a
  $5.20 card that ships free beats a $4.80 card that does not.
- Deck orders pay shipping per order, not per card, with an adjustable number
  of sellers.

---

## Quick start

Two ways to run it, both with live prices for every card ever printed.

**With the server** — adds live eBay listings when you supply credentials:

```bash
npm install
npm start
# http://localhost:3000
```

**With no backend at all** — Scryfall serves `Access-Control-Allow-Origin: *`,
so the whole app runs as a static site straight from your browser:

```bash
npm install
npm run serve:static     # builds dist/ and serves it on :8080
# or: npm run build:static && npx serve dist
```

`dist/` is plain ES modules — the same files you can read in `server/lib/` — so
it drops onto GitHub Pages, S3 or any static host unchanged. The only feature it
gives up is eBay: that needs an OAuth client secret, which has no safe home in a
page anyone can view, so it falls back to pre-filtered eBay search links.

Node 20+ is required. The app has one runtime dependency (Express); everything
else is standard library.

```bash
npm test     # 129 tests, no network access needed
```

---

## Where the prices come from

| Vendor | What you get | Source |
| --- | --- | --- |
| **TCGplayer** | Market price per printing (USD) | [Scryfall](https://scryfall.com/docs/api), refreshed daily |
| **Cardmarket** | Trend price per printing (EUR) | Scryfall, refreshed daily |
| **eBay** | Real live listings: price, shipping, condition, seller rating, photo | eBay Browse API (optional, see below) |
| **Card Kingdom / Star City Games / CoolStuffInc** | Deep link into their catalogue search | — |

Three honesty rules the code follows:

1. **A price is only ever shown when a real source provides it.** Stores with no
   public price API get a search link, never an invented number. The UI labels
   which is which.
2. **USD and EUR are never mixed.** Converting between them would need an
   exchange rate the app does not have, so "cheapest" is always computed inside
   the market you selected.
3. **Estimated shipping is labelled as estimated, everywhere it appears.**
   Only eBay publishes a real per-listing shipping cost, and that number flows
   through untouched.

Scryfall's [API guidelines](https://scryfall.com/docs/api) are respected: a
descriptive `User-Agent`, a serialised request queue with ~110 ms spacing, retry
with backoff on 429/5xx, and aggressive response caching.

---

## Shipping

The cheapest sticker price is not the cheapest card, so shipping is included by
default and the headline figure is what you pay delivered.

| Vendor | Shipping |
| --- | --- |
| **eBay** | Real, per listing, straight from the Browse API — price + shipping is what the strip sorts by |
| **TCGplayer / Cardmarket** | An **estimate** you control: a per-order cost and a free-over threshold |

There is no public per-seller shipping quote for a given card at TCGplayer or
Cardmarket, so the alternative to an editable estimate is an invented number
presented as fact. The estimate is editable in the header (and remembered in
your browser), overridable per deployment via `SHIPPING_PER_ORDER_*` /
`SHIPPING_FREE_OVER_*`, and can be switched off entirely.

Two details that matter:

- **Thresholds reorder results.** With $1.29 shipping free over $5, a $4.80
  card lands at $6.09 and a $5.20 card lands at $5.20 — so the pricier card
  wins, and the ranking says so.
- **Decks pay per order, not per card.** The deck total adds shipping once,
  with a "separate orders" control for the realistic case where your list comes
  from several sellers. The threshold is then applied per shipment, which is
  how stores actually charge it.

---

## Good deals

The deals strip is built from real data, not a curated list of favourites:

1. Ask Scryfall for cards in a price band, sorted by EDHREC play rank, so the
   pool is cards people genuinely play rather than cheap filler.
2. Look up the true cheapest genuine printing of each (reusing the same
   filtering and shipping rules as everything else).
3. Where the same card also has a much pricier printing of the *same finish*,
   report the gap. Finishes are compared like with like — a foil costing eight
   times its non-foil twin is ordinary foil pricing, not a bargain, and quoting
   it would overstate every saving on the page. The percentage is floored so it
   never overstates.

Themes rotate on load and on "Shuffle"; `GET /api/deals?theme=<id>` pins one.
If Scryfall returns nothing, the strip simply does not render.

The marquee pauses on hover and on keyboard focus, and under
`prefers-reduced-motion` it becomes a plain scrollable row.

---

## The no-proxy policy

Scryfall only indexes cards actually printed by Wizards of the Coast, so
counterfeits never enter the catalogue. On top of that, these are filtered out
before anything is priced:

| Hidden | Why |
| --- | --- |
| Digital-only printings (Arena, MTGO) | Not a physical card you can own |
| Collector's Edition / International Edition (`ced`, `cei`) | Square corners, not tournament legal |
| 30th Anniversary Edition (`30a`) | Non-standard card back — unusable in play |
| Gold-bordered World Championship decks | Not tournament legal |
| Oversized display cards | Physically unplayable — hidden unconditionally |
| Tokens, emblems, art series, schemes, planes | Not the card you searched for |

The "Include collector-only printings" toggle lets the memorabilia back in for
collectors who genuinely want it, clearly labelled. Oversized cards stay hidden
either way. Whatever is hidden is counted and explained on the page.

Marketplace listings get a second screen, because eBay *does* carry proxies:

- Searches are scoped to eBay's CCG-singles category with proxy vocabulary as
  negative keywords (`proxy`, `custom`, `replica`, `altered`, `counterfeit`, …).
- Returned titles are re-screened against a broader pattern (including
  `playtest card`, `hand painted`, `high quality copy`, `gold border`).
- A listing must actually name the card searched for — no sleeves or playmats.
- Sellers below 95% positive feedback or under 10 ratings are dropped.

---

## Deck list formats

All of these parse, in one list, mixed together:

```
// comments and # comments are ignored
Deck                       <- section headers
4 Lightning Bolt           <- plain
4x Snapcaster Mage         <- "x" suffix
x3 Forest                  <- "x" prefix
4 Ragavan, Nimble Pilferer (MH2) 138   <- Arena / MTGO / Moxfield
3 Thoughtseize [MM3] 108               <- bracket set codes
1 Atraxa, Praetors' Voice (2XM) 190 *F*   <- foil, *E* for etched
1 Sol Ring #Commander                     <- Archidekt / Deckstats tags
2 Snapcaster Mage (MM3) 42 [Maybeboard{noDeck}]
SB: 2 Pyroblast            <- MWS sideboard
2 Fire // Ice              <- split cards survive the "//" comment rule
```

Also handled: straight vs. typographic apostrophes (`Agadeem's` matches
`Agadeem’s`), accents (`Lim-Dul` matches `Lim-Dûl`), duplicate lines merging,
and a per-request cap of 600 distinct cards.

---

## Optional: live eBay listings

Without credentials the app works fully; eBay appears as a pre-filtered search
link. With them, you get real listings and listing photos.

```bash
cp .env.example .env
# fill in EBAY_CLIENT_ID and EBAY_CLIENT_SECRET from https://developer.ebay.com/
```

The app uses the OAuth2 client-credentials flow and the Browse API. Tokens are
cached until expiry; an eBay outage degrades to "no listings" and never breaks
the page.

---

## HTTP API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Price source, vendor registry, shipping defaults, deal themes, whether live listings are on |
| `GET /api/deals?theme=&currency=&limit=` | The rotating good-deals strip |
| `GET /api/autocomplete?q=` | Card-name suggestions |
| `GET /api/card?q=&currency=&includeCollectibles=&finish=` | One card: every genuine printing, priced and ranked |
| `GET /api/card?id=<scryfall-id>` | Same, for a specific printing |
| `GET /api/search?q=` | Free-text card search (the "did you mean" list) |
| `GET /api/listings?name=&set=&limit=` | Screened live marketplace listings |
| `POST /api/deck` | `{ list, currency, includeCollectibles }` → priced deck |

`public/app.js` never fetches a URL itself — it calls `./api.js`. Swapping that
one module is what turns the server build into the static build, so both run the
identical front end and the identical pricing modules.

Every pricing endpoint also accepts `shipping` (`true`/`false`),
`shippingPerOrder`, `shippingFreeOver` (blank for none) and `orders`.

---

## Project layout

```
server/
  app.js                 Express app factory (CSP, static, routes)
  index.js               entry point
  lib/
    scryfall.js          rate-limited, cached, retrying Scryfall client
    authenticity.js      proxy / non-playable filtering  <- the no-fakes rules
    offers.js            printings -> comparable priced offers
    vendors.js           vendor registry + proxy-filtered search URLs
    deckParser.js        deck list formats -> structured entries
    deckPricing.js       bulk resolve + price a whole list
    shipping.js          shipping estimates, thresholds and per-order maths
    deals.js             the rotating good-deals strip
    ebay.js              optional Browse API adapter
    cache.js             TTL cache with in-flight de-duplication
  routes/api.js          HTTP surface
public/
  index.html             the page
  styles.css             the styles
  app.js                 the front end — transport-agnostic, no framework
  api.js                 transport: this app's own HTTP API
web/api-direct.js        transport: Scryfall straight from the browser
scripts/build-static.mjs assembles dist/ for the backend-free build
test/                    129 tests against Scryfall-shaped fixtures
```

---

## Notes and limitations

- **Prices are market/trend prices, not a specific seller's current stock.**
  They are the standard figure TCGplayer and Cardmarket publish, refreshed
  daily. Click through for what a seller is charging right now.
- **TCGplayer has no open price API** — their partner API is approval-gated — so
  the TCGplayer figure comes via Scryfall rather than a direct integration.
- **Condition is not a filter for market prices.** Scryfall publishes one price
  per printing/finish, not one per condition grade.
- **Shipping for TCGplayer and Cardmarket is your estimate, not a quote.** Real
  cost varies by seller, quantity and destination. eBay's figure is real.
- **Card Kingdom / SCG / CoolStuffInc are links, not prices,** for the reason in
  the honesty rules above.
- This project was built in a sandbox where `api.scryfall.com` is blocked by
  network policy. Every code path is covered by tests against fixtures that
  mirror the documented Scryfall response shapes, and the full UI was driven
  end-to-end against those fixtures — but the first run against the live API is
  worth eyeballing.

---

## Legal

Unofficial Fan Content permitted under the Wizards of the Coast Fan Content
Policy. Not approved or endorsed by Wizards. Portions of the materials used are
property of Wizards of the Coast LLC. Card data and images come from Scryfall.
