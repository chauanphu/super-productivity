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

  it('increments atomically and locks when the returned count reaches 5', async () => {
    mockUser.findUnique.mockResolvedValue(row({ failedLoginAttempts: 4 }));
    mockUser.update.mockResolvedValueOnce({ failedLoginAttempts: 5 });
    await expect(loginWithPassword('a@b.com', 'bad')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(mockUser.update.mock.calls[0][0].data).toEqual({
      failedLoginAttempts: { increment: 1 },
    });
    const lock = mockUser.update.mock.calls[1][0].data;
    expect(Number(lock.lockedUntil)).toBeGreaterThan(Date.now());
  });

  it('does not lock while the returned count is below 5', async () => {
    mockUser.findUnique.mockResolvedValue(row({ failedLoginAttempts: 1 }));
    mockUser.update.mockResolvedValueOnce({ failedLoginAttempts: 2 });
    await expect(loginWithPassword('a@b.com', 'bad')).rejects.toThrow();
    expect(mockUser.update).toHaveBeenCalledTimes(1);
  });

  it('after lock expiry the first wrong guess restarts the counter and does not re-lock', async () => {
    mockUser.findUnique.mockResolvedValue(
      row({ failedLoginAttempts: 5, lockedUntil: BigInt(Date.now() - 1000) }),
    );
    mockUser.update.mockResolvedValueOnce({ failedLoginAttempts: 1 });
    await expect(loginWithPassword('a@b.com', 'bad')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(mockUser.update).toHaveBeenCalledTimes(1);
    expect(mockUser.update.mock.calls[0][0].data).toEqual({
      failedLoginAttempts: 1,
      lockedUntil: null,
    });
  });

  it('a wrong password on a locked account does not touch the lock', async () => {
    mockUser.findUnique.mockResolvedValue(
      row({ failedLoginAttempts: 5, lockedUntil: BigInt(Date.now() + 60_000) }),
    );
    await expect(loginWithPassword('a@b.com', 'bad')).rejects.toThrow(
      'Invalid credentials',
    );
    expect(mockUser.update).not.toHaveBeenCalled();
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
