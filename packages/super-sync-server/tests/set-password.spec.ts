import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as bcrypt from 'bcryptjs';

vi.mock('../src/db', () => ({
  prisma: { user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } },
  disconnectDb: vi.fn(),
}));

import { prisma } from '../src/db';
import { parseSetPasswordArgs, setPassword } from '../scripts/set-password';

const user = prisma.user as unknown as Record<'findUnique' | 'create' | 'update', Mock>;

describe('setPassword', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a verified user with a bcrypt hash and lowercased email', async () => {
    user.findUnique.mockResolvedValue(null);
    const res = await setPassword('  Foo@Example.COM ', 'correct-horse-battery');
    expect(res).toEqual({ created: true });
    expect(user.findUnique).toHaveBeenCalledWith({ where: { email: 'foo@example.com' } });
    const data = user.create.mock.calls[0][0].data;
    expect(data.email).toBe('foo@example.com');
    expect(data.isVerified).toBe(1);
    expect(data.passwordHash).not.toBe('correct-horse-battery');
    expect(await bcrypt.compare('correct-horse-battery', data.passwordHash)).toBe(true);
  });

  it('updates an existing user without touching tokenVersion and resets lockout', async () => {
    user.findUnique.mockResolvedValue({ id: 7, tokenVersion: 3 });
    const res = await setPassword('a@b.co', 'correct-horse-battery');
    expect(res).toEqual({ created: false });
    expect(user.create).not.toHaveBeenCalled();
    const arg = user.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 7 });
    expect(arg.data).toMatchObject({
      isVerified: 1,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    expect(arg.data).not.toHaveProperty('tokenVersion');
    expect(await bcrypt.compare('correct-horse-battery', arg.data.passwordHash)).toBe(
      true,
    );
  });

  it('rejects passwords shorter than 10 chars', async () => {
    await expect(setPassword('a@b.co', 'short')).rejects.toThrow();
    expect(user.create).not.toHaveBeenCalled();
    expect(user.update).not.toHaveBeenCalled();
  });

  it('rejects passwords over 72 bytes (bcrypt would truncate silently)', async () => {
    await expect(setPassword('a@b.co', 'é'.repeat(37))).rejects.toThrow(/72 bytes/);
    expect(user.findUnique).not.toHaveBeenCalled();
    user.findUnique.mockResolvedValue(null);
    await expect(setPassword('a@b.co', 'x'.repeat(72))).resolves.toEqual({
      created: true,
    });
  });

  it('bumps tokenVersion only with revokeSessions', async () => {
    user.findUnique.mockResolvedValue({ id: 7, tokenVersion: 3 });
    await setPassword('a@b.co', 'correct-horse-battery', { revokeSessions: true });
    expect(user.update.mock.calls[0][0].data.tokenVersion).toEqual({ increment: 1 });
  });
});

describe('parseSetPasswordArgs', () => {
  it('reads email, password and --revoke-sessions in any order', () => {
    expect(parseSetPasswordArgs(['--revoke-sessions', 'a@b.co', 'pw'], {})).toEqual({
      email: 'a@b.co',
      password: 'pw',
      revokeSessions: true,
    });
  });

  it('falls back to SET_PASSWORD_PASSWORD when the password is omitted', () => {
    expect(parseSetPasswordArgs(['a@b.co'], { SET_PASSWORD_PASSWORD: 'envpw' })).toEqual({
      email: 'a@b.co',
      password: 'envpw',
      revokeSessions: false,
    });
    expect(parseSetPasswordArgs(['a@b.co'], {}).password).toBeUndefined();
  });
});
