/**
 * Module-level state of a running local data wipe (LocalDataWipeService). Kept in its
 * own file so the op-log capture effect and SyncWrapperService can read it without an
 * import cycle.
 */
let isWiping = false;
let isReloading = false;

/** Set before SUP_OPS is cleared; only a reload ends it (or a failure before the clear). */
export const isLocalDataWipeInProgress = (): boolean => isWiping;
export const setLocalDataWipeInProgress = (v: boolean): void => {
  isWiping = v;
};

/** The web beforeunload prompt must not cancel the reload that follows a wipe. */
export const isLocalDataWipeReloading = (): boolean => isReloading;
export const setLocalDataWipeReloading = (): void => {
  isReloading = true;
};

export const SKIP_BACKUP_PROMPT_ONCE_KEY = 'SP_SKIP_BACKUP_PROMPT_ONCE';

/** True once after a wipe: the startup "restore from backup" prompt is skipped. */
export const consumeSkipBackupPromptOnce = (): boolean => {
  const isSet = localStorage.getItem(SKIP_BACKUP_PROMPT_ONCE_KEY) === '1';
  localStorage.removeItem(SKIP_BACKUP_PROMPT_ONCE_KEY);
  return isSet;
};
