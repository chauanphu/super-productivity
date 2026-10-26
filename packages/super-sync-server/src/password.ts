import * as bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 12;

// Compared against when the user/hash is missing so response time doesn't reveal existence.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_ROUNDS);

export const verifyPassword = async (
  plain: string,
  hash: string | null,
): Promise<boolean> => {
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return hash !== null && ok;
};
