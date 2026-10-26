import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-validation';
});

vi.mock('../src/db', () => ({
  prisma: { user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } },
}));
vi.mock('../src/email', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(true),
  sendLoginMagicLinkEmail: vi.fn().mockResolvedValue(true),
}));
// tests/setup.ts mocks auth globally; use the real login logic here.
vi.mock('../src/auth', async (importOriginal) => importOriginal());

import { prisma } from '../src/db';
import { apiRoutes } from '../src/api';

const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;

const REGISTRATION_ROUTES: [string, object][] = [
  ['/api/register/passkey/options', { email: 'new@test.com', termsAccepted: true }],
  ['/api/register/passkey/verify', { email: 'new@test.com', credential: {} }],
  ['/api/register/magic-link', { email: 'new@test.com', termsAccepted: true }],
];

describe('REGISTRATION_DISABLED', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(apiRoutes, { prefix: '/api' });
    await app.ready();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it.each(REGISTRATION_ROUTES)('%s returns 403 when disabled', async (url, payload) => {
    vi.stubEnv('REGISTRATION_DISABLED', 'true');
    const res = await app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Registration is disabled' });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects before body validation', async () => {
    vi.stubEnv('REGISTRATION_DISABLED', 'true');
    const res = await app.inject({
      method: 'POST',
      url: '/api/register/magic-link',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('is open by default (unset)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/register/magic-link',
      payload: {},
    });
    expect(res.statusCode).toBe(400); // reaches validation
  });

  it('password login is unaffected', async () => {
    vi.stubEnv('REGISTRATION_DISABLED', 'true');
    findUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/login/password',
      payload: { email: 'a@b.com', password: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('magic-link login is unaffected', async () => {
    vi.stubEnv('REGISTRATION_DISABLED', 'true');
    findUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/login/magic-link',
      payload: { email: 'a@b.com' },
    });
    expect(res.statusCode).not.toBe(403);
  });
});
