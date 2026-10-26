import { prisma, disconnectDb } from '../src/db';
import { Logger } from '../src/logger';
import { hashPassword } from '../src/password';

const MIN_PASSWORD_LENGTH = 6;
// bcrypt ignores everything after 72 bytes.
const MAX_PASSWORD_BYTES = 72;
const USAGE =
  'Usage: npm run set-password -- [--revoke-sessions] <email> [<password>]\n' +
  '       (password may instead come from the SET_PASSWORD_PASSWORD env variable)';

export const parseSetPasswordArgs = (
  argv: string[],
  env: Record<string, string | undefined>,
): { email?: string; password?: string; revokeSessions: boolean } => {
  const [email, password] = argv.filter((a) => a !== '--revoke-sessions');
  return {
    email,
    password: password ?? env.SET_PASSWORD_PASSWORD,
    revokeSessions: argv.includes('--revoke-sessions'),
  };
};

export const setPassword = async (
  rawEmail: string,
  password: string,
  { revokeSessions = false }: { revokeSessions?: boolean } = {},
): Promise<{ created: boolean }> => {
  const email = rawEmail.trim().toLowerCase();
  if (!email) throw new Error('Email is required.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new Error(`Password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
  }
  const passwordHash = await hashPassword(password);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // By default existing sessions stay valid; --revoke-sessions invalidates them.
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        isVerified: 1,
        failedLoginAttempts: 0,
        lockedUntil: null,
        ...(revokeSessions ? { tokenVersion: { increment: 1 } } : {}),
      },
    });
    return { created: false };
  }
  await prisma.user.create({ data: { email, passwordHash, isVerified: 1 } });
  return { created: true };
};

const main = async (): Promise<void> => {
  const { email, password, revokeSessions } = parseSetPasswordArgs(
    process.argv.slice(2),
    process.env,
  );
  if (!email || !password) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    const { created } = await setPassword(email, password, { revokeSessions });
    Logger.info(
      created
        ? 'User created with password.'
        : `Password updated${revokeSessions ? ', existing sessions revoked' : ''}.`,
    );
  } catch (error) {
    Logger.error('Error setting password:', error instanceof Error ? error.message : '');
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
};

if (require.main === module) {
  void main();
}
