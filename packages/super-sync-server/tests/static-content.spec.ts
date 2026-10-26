import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { registerStaticContent, resolveWebRoot } from '../src/static-content';

const INDEX = '<!doctype html><title>angular-app</title>';

describe('registerStaticContent', () => {
  let webRoot: string;
  let app: FastifyInstance;

  beforeAll(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-root-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), INDEX);
    fs.writeFileSync(path.join(webRoot, 'main-AB12CD34.js'), 'console.log(1)');
    fs.writeFileSync(path.join(webRoot, 'ngsw-worker.js'), '//sw');
    fs.writeFileSync(path.join(webRoot, 'ngsw.json'), '{}');
    fs.mkdirSync(path.join(webRoot, 'assets/i18n'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'assets/i18n/en.json'), '{}');
  });
  afterAll(() => fs.rmSync(webRoot, { recursive: true, force: true }));
  afterEach(() => app.close());

  const build = async (root: string | undefined): Promise<FastifyInstance> => {
    app = Fastify();
    await app.register(helmet);
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/api/ping', async () => ({ pong: true }));
    await registerStaticContent(app, root);
    await app.ready();
    return app;
  };

  describe('with WEB_ROOT', () => {
    it('serves index.html at / with no-cache and without helmet CSP', async () => {
      await build(webRoot);
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('serves hashed assets as immutable', async () => {
      await build(webRoot);
      const res = await app.inject({ method: 'GET', url: '/main-AB12CD34.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it.each(['/ngsw-worker.js', '/ngsw.json', '/assets/i18n/en.json'])(
      '%s is no-cache',
      async (url) => {
        await build(webRoot);
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-cache');
      },
    );

    it('keeps /api and /health routed, with the API CSP', async () => {
      await build(webRoot);
      const api = await app.inject({ method: 'GET', url: '/api/ping' });
      expect(api.json()).toEqual({ pong: true });
      expect(api.headers['content-security-policy']).toBeDefined();
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.json()).toEqual({ status: 'ok' });
    });

    it('falls back to index.html for unknown extensionless paths', async () => {
      await build(webRoot);
      const res = await app.inject({ method: 'GET', url: '/some/route?x=1' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it.each([
      ['GET', '/api/unknown'],
      ['GET', '/api'],
      ['GET', '/chunk-OLDHASH1.js'],
      ['POST', '/some/route'],
    ])('%s %s is a 404, not index.html', async (method, url) => {
      await build(webRoot);
      const res = await app.inject({ method: method as 'GET' | 'POST', url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Not Found');
    });

    it('does not serve the legacy public pages', async () => {
      await build(webRoot);
      const res = await app.inject({ method: 'GET', url: '/app.js' });
      expect(res.statusCode).toBe(404);
      const page = await app.inject({ method: 'GET', url: '/reset-password?token=x' });
      expect(page.body).toBe(INDEX);
    });
  });

  describe('without WEB_ROOT (legacy)', () => {
    it('serves the legacy public pages and page routes', async () => {
      await build(undefined);
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.body).not.toBe(INDEX);
      expect(index.headers['content-security-policy']).toBeDefined();
      const appJs = await app.inject({ method: 'GET', url: '/app.js' });
      expect(appJs.statusCode).toBe(200);
      const page = await app.inject({ method: 'GET', url: '/reset-password' });
      expect(page.statusCode).toBe(400); // page route: "Token is required"
      const unknown = await app.inject({ method: 'GET', url: '/some/route' });
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe('resolveWebRoot', () => {
    it('ignores unset or missing directories', () => {
      expect(resolveWebRoot(undefined)).toBeUndefined();
      expect(resolveWebRoot(path.join(webRoot, 'nope'))).toBeUndefined();
      expect(resolveWebRoot(webRoot)).toBe(webRoot);
    });
  });
});
