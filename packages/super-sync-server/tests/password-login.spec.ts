import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import * as jwt from 'jsonwebtoken';
import { prisma } from '../src/db';
import { loginWithPassword } from '../src/auth';
import { hashPassword, verifyPassword } from '../src/password';

const mockUser = (prisma as any).user as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

describe('password login', () => {
  let hash: string;
  const row = (over: object = {}): object => ({
    id: 7,
    email: 'a@b.com',
    passwordHash: hash,
    isVerified: 1,
    tokenVersion: 3,
    failedLoginAttempts: 0,
    lockedUntil: null,
    ...over,
  });

  beforeEach(async () => {
    hash ??= await hashPassword('correct-horse');
    vi.clearAllMocks();
    mockUser.update.mockResolvedValue({});
  });

  it('returns a token for the right password (email case/whitespace-insensitive)', async () => {
    mockUser.findUnique.mockResolvedValue(row());
    const res = await loginWithPassword('  A@B.com ', 'correct-horse');
    expect(mockUser.findUnique.mock.calls[0][0].where.email).toBe('a@b.com');
    expect(res.user).toEqual({ id: 7, email: 'a@b.com' });
    const p = jwt.verify(res.token, process.env.JWT_SECRET!) as any;
    expect(p).toMatchObject({ userId: 7, email: 'a@b.com', tokenVersion: 3 });
  });

  it('resets counters on success and never bumps tokenVersion', async () => {
    mockUser.findUnique.mockResolvedValue(row({ failedLoginAttempts: 2 }));
    await loginWithPassword('a@b.com', 'correct-horse');
    expect(mockUser.update).toHaveBeenCalledTimes(1);
    const data = mockUser.update.mock.calls[0][0].data;
    expect(data).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
  });

  it.each([
    ['wrong password', row(), 'nope'],
    ['unknown user', null, 'correct-horse'],
    ['null passwordHash', row({ passwordHash: null }), 'correct-horse'],
    ['unverified', row({ isVerified: 0 }), 'correct-horse'],
  ])('rejects: %s', async (_n, user, pw) => {
    mockUser.findUnique.mockResolvedValue(user);
    await expect(loginWithPassword('a@b.com', pw)).rejects.toThrow('Invalid credentials');
  });

  it('locks on the 5th consecutive failure', async () => {
    mockUser.findUnique.mockResolvedValue(row({ failedLoginAttempts: 4 }));
    await expect(loginWithPassword('a@b.com', 'bad')).rejects.toThrow(
      'Invalid credentials',
    );
    const data = mockUser.update.mock.calls[0][0].data;
    expect(data.failedLoginAttempts).toBe(5);
    expect(Number(data.lockedUntil)).toBeGreaterThan(Date.now());
  });

  it('does not lock before the 5th failure', async () => {
    mockUser.findUnique.mockResolvedValue(row({ failedLoginAttempts: 1 }));
    await expect(loginWithPassword('a@b.com', 'bad')).rejects.toThrow();
    const data = mockUser.update.mock.calls[0][0].data;
    expect(data.failedLoginAttempts).toBe(2);
    expect(data.lockedUntil).toBeUndefined();
  });

  it('rejects while locked even with the right password', async () => {
    mockUser.findUnique.mockResolvedValue(
      row({ failedLoginAttempts: 5, lockedUntil: BigInt(Date.now() + 60_000) }),
    );
    await expect(loginWithPassword('a@b.com', 'correct-horse')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(mockUser.update).not.toHaveBeenCalled();
  });

  it('verifyPassword(…, null) is false', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
  });
});
