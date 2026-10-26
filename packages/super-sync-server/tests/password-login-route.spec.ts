import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-validation';
});

vi.mock('../src/db', () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock('../src/email', () => ({
  sendVerificationEmail: vi.fn(),
  sendLoginMagicLinkEmail: vi.fn(),
}));
vi.mock('../src/auth', async (importOriginal) => importOriginal());

import { prisma } from '../src/db';
import { Logger } from '../src/logger';
import { apiRoutes } from '../src/api';

const findUnique = (prisma as any).user.findUnique as ReturnType<typeof vi.fn>;

describe('POST /api/login/password', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(apiRoutes, { prefix: '/api' });
    await app.ready();
  });
  afterEach(() => app.close());

  const post = (payload: object): ReturnType<FastifyInstance['inject']> =>
    app.inject({ method: 'POST', url: '/api/login/password', payload });

  it('401 Invalid credentials for an unknown user', async () => {
    findUnique.mockResolvedValue(null);
    const res = await post({ email: 'a@b.com', password: 'x' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('padded/mixed-case email is normalised, not rejected with 400', async () => {
    findUnique.mockResolvedValue(null);
    const res = await post({ email: ' User1@Example.com ', password: 'x' });
    expect(res.statusCode).toBe(401);
    expect(findUnique.mock.calls[0][0].where.email).toBe('user1@example.com');
  });

  it('400 on a malformed body', async () => {
    expect((await post({ email: 'nope' })).statusCode).toBe(400);
  });

  it('500 + logged (without PII) when the DB fails, not 401', async () => {
    const spy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    // Prisma error messages can echo query arguments such as the email.
    class PrismaClientKnownRequestError extends Error {}
    findUnique.mockRejectedValue(
      new PrismaClientKnownRequestError('Unique failed on email secret@b.com'),
    );
    const res = await post({ email: 'secret@b.com', password: 'hunter2' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).not.toBe('Invalid credentials');
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('PrismaClientKnownRequestError');
    expect(logged).not.toContain('Unique failed');
    expect(logged).not.toContain('secret@b.com');
    expect(logged).not.toContain('hunter2');
  });
});
