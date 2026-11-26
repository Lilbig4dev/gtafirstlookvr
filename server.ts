import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = 'https://gta5-87g.pages.dev';
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const publicDir = path.resolve(__dirname, 'public');
const distDir = path.resolve(__dirname, 'dist');

async function startServer() {
  const app = express();

  // Required for SharedArrayBuffer, Wasm Memory64 threads, and crossOriginIsolated === true
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  // Engine / page diagnostic log endpoint (?log=1)
  app.post('/log', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  // Serve copied local static assets (JS, WASM chunks, shaders, title art, __support)
  const staticRoot = IS_PROD && fs.existsSync(distDir) ? distDir : publicDir;
  app.use(
    express.static(staticRoot, {
      index: ['index.html'],
      redirect: true,
      setHeaders: (res, filePath) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        if (filePath.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        } else if (filePath.endsWith('.woff')) {
          res.setHeader('Content-Type', 'font/woff');
        } else if (filePath.endsWith('.webp')) {
          res.setHeader('Content-Type', 'image/webp');
        }
      },
    })
  );

  // Streaming Range-aware proxy for the 19.57 GB /data/* and /__chunks/* game archives
  app.use(['/data', '/__chunks', '/b'], async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    const upstreamUrl = UPSTREAM + req.originalUrl;
    const headers: Record<string, string> = {
      'Accept-Encoding': 'identity',
    };
    if (typeof req.headers.range === 'string') {
      headers['Range'] = req.headers.range;
    }
    if (typeof req.headers['if-none-match'] === 'string') {
      headers['If-None-Match'] = req.headers['if-none-match'];
    }
    if (typeof req.headers['if-modified-since'] === 'string') {
      headers['If-Modified-Since'] = req.headers['if-modified-since'];
    }

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers,
      });

      res.status(upstreamRes.status);
      for (const h of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'cache-control',
        'etag',
        'last-modified',
      ]) {
        const val = upstreamRes.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

      if (req.method === 'HEAD' || !upstreamRes.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstreamRes.body as unknown as import('node:stream/web').ReadableStream);
      nodeStream.on('error', () => {
        if (!res.headersSent) res.status(502);
        res.end();
      });
      res.on('close', () => {
        nodeStream.destroy();
      });
      nodeStream.pipe(res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).send('Upstream asset proxy error: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'mpa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GTA V WebGPU + Quest 3 WebXR server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
