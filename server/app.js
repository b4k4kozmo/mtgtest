import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createScryfallClient } from './lib/scryfall.js';
import { createEbayClient } from './lib/ebay.js';
import { createApiRouter } from './routes/api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

export function createApp({ scryfall = createScryfallClient(), ebay = createEbayClient() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '512kb' }));

  // Images come from Scryfall's CDN and (optionally) eBay's; everything else
  // is served from this origin.
  app.use((req, res, next) => {
    res.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: https://cards.scryfall.io https://c1.scryfall.com https://i.ebayimg.com",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use('/api', createApiRouter({ scryfall, ebay }));

  app.use(express.static(publicDir, { maxAge: '1h', extensions: ['html'] }));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unknown endpoint.' });
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Body-parser failures happen before the API router, so they need catching
  // here or Express replies with an HTML error page to a JSON client.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'That request body was not valid JSON.' });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'That deck list is too large to send.' });
    }
    console.error('[app]', err);
    return res.status(500).json({ error: 'Something went wrong handling that request.' });
  });

  return app;
}
