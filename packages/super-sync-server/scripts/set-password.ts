import { prisma, disconnectDb } from '../src/db';
import { Logger } from '../src/logger';
import { hashPassword } from '../src/password';

const MIN_PASSWORD_LENGTH = 10;

export const setPassword = async (
  rawEmail: string,
  password: string,
): Promise<{ created: boolean }> => {
  const email = rawEmail.trim().toLowerCase();
  if (!email) throw new Error('Email is required.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const passwordHash = await hashPassword(password);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // tokenVersion intentionally untouched: existing sessions stay valid.
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, isVerified: 1, failedLoginAttempts: 0, lockedUntil: null },
    });
    return { created: false };
  }
  await prisma.user.create({ data: { email, passwordHash, isVerified: 1 } });
  return { created: true };
};

const main = async (): Promise<void> => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run set-password -- <email> <password>');
    process.exit(1);
  }
  try {
    const { created } = await setPassword(email, password);
    Logger.info(created ? 'User created with password.' : 'Password updated.');
  } catch (error) {
    Logger.error('Error setting password:', error instanceof Error ? error.message : '');
    process.exit(1);
  } finally {
    await disconnectDb();
  }
};

if (require.main === module) {
  void main();
}
