import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const app = createApp();

app.listen(port, () => {
  const ebayReady = Boolean(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET);
  console.log(`MTG Price Finder listening on http://localhost:${port}`);
  console.log(`Prices: Scryfall (TCGplayer / Cardmarket). Live eBay listings: ${ebayReady ? 'enabled' : 'disabled (set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)'}`);
});
