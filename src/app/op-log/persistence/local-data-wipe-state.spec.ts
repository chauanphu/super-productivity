import {
  consumeSkipBackupPromptOnce,
  SKIP_BACKUP_PROMPT_ONCE_KEY,
} from './local-data-wipe-state';

describe('consumeSkipBackupPromptOnce', () => {
  afterEach(() => localStorage.removeItem(SKIP_BACKUP_PROMPT_ONCE_KEY));

  it('is true exactly once after a wipe set the flag', () => {
    localStorage.setItem(SKIP_BACKUP_PROMPT_ONCE_KEY, '1');
    expect(consumeSkipBackupPromptOnce()).toBe(true);
    expect(localStorage.getItem(SKIP_BACKUP_PROMPT_ONCE_KEY)).toBeNull();
    expect(consumeSkipBackupPromptOnce()).toBe(false);
  });

  it('is false without the flag', () => {
    expect(consumeSkipBackupPromptOnce()).toBe(false);
  });
});
