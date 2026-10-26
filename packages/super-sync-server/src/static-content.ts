import * as fs from 'fs';
import * as path from 'path';
import { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { pageRoutes } from './pages';
import { Logger } from './logger';

// dist/src/ -> ../../public when compiled, src/ -> ../public when run from source
const LEGACY_PUBLIC_DIR =
  ['../../public', '../public'].map((p) => path.join(__dirname, p)).find(fs.existsSync) ??
  path.join(__dirname, '../../public');

// Angular's outputHashing=all names: main-ABCD1234.js, chunk-XXXXXXXX.js, media/font-XXXXXXXX.woff2
const HASHED_FILE = /-[A-Z0-9]{8}\.[a-z0-9]+$/;

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const isApiPath = (url: string): boolean =>
  url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

/** True for requests the web app owns (everything except the API and /health). */
export const isWebAppRequest = (req: FastifyRequest): boolean =>
  !isApiPath(req.url) && req.url !== '/health' && !req.url.startsWith('/health?');

/** Returns WEB_ROOT if it is set and is a directory containing index.html. */
export const resolveWebRoot = (webRoot: string | undefined): string | undefined => {
  if (!webRoot) return undefined;
  const resolved = path.resolve(webRoot);
  if (!fs.existsSync(path.join(resolved, 'index.html'))) {
    Logger.warn(`WEB_ROOT ${resolved} has no index.html; serving legacy pages instead`);
    return undefined;
  }
  return resolved;
};

/**
 * Serves either the built Angular app (webRoot set) or the legacy public/ pages.
 * Must be called on the root instance after the API routes are registered.
 */
export const registerStaticContent = async (
  app: FastifyInstance,
  webRoot: string | undefined,
): Promise<void> => {
  if (!webRoot) {
    await app.register(fastifyStatic, { root: LEGACY_PUBLIC_DIR, prefix: '/' });
    await app.register(pageRoutes, { prefix: '/' });
    return;
  }

  // The app ships its own (permissive) CSP <meta> for integrations, plugins and its inline
  // compat script; helmet's strict API CSP would intersect with it and break the app.
  // Added before @fastify/static so its encapsulated routes inherit the hook.
  app.addHook('onSend', async (req, reply, payload) => {
    // helmet writes its headers to the raw response, so remove it there.
    if (isWebAppRequest(req)) reply.raw.removeHeader('content-security-policy');
    return payload;
  });

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const rel = path.relative(webRoot, filePath);
      const hashed = !rel.startsWith(`assets${path.sep}`) && HASHED_FILE.test(rel);
      res.setHeader('Cache-Control', hashed ? IMMUTABLE : NO_CACHE);
    },
  });

  // SPA fallback (the app uses hash routing, so this is only a safety net). Paths with a
  // file extension stay 404 so a stale chunk URL never gets HTML back.
  app.setNotFoundHandler((req, reply) => {
    const lastSegment = req.url.split('?')[0].split('/').pop() ?? '';
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      isWebAppRequest(req) &&
      !lastSegment.includes('.')
    ) {
      return reply.header('Cache-Control', NO_CACHE).sendFile('index.html');
    }
    return reply.status(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });
};
