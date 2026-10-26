import { inject, Injectable } from '@angular/core';
import { OperationLogStoreService } from './operation-log-store.service';
import { LegacyPfDbService } from '../../core/persistence/legacy-pf-db.service';
import {
  LAST_SYNCED_PROVIDER_KEY,
  SyncProviderManager,
} from '../sync-providers/provider-manager.service';
import { SyncProviderId } from '../sync-providers/provider.const';
import { LAST_SERVER_SEQ_KEY_PREFIX } from '../sync-providers/super-sync/super-sync';
import {
  AuthSession,
  SuperSyncAuthService,
} from '../sync-providers/super-sync/super-sync-auth.service';
import { FIRST_SYNC_MERGE_DONE_KEY_PREFIX } from '../sync/first-sync-merge/first-sync-merge.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { OperationWriteFlushService } from '../sync/operation-write-flush.service';
import { LockService } from '../sync/lock.service';
import { LOCK_NAMES } from '../core/operation-log.const';
import {
  PROFILE_DATA_PREFIX,
  PROFILE_META_KEY,
} from '../../features/user-profile/user-profile-storage.service';
import { IS_ELECTRON } from '../../app.constants';
import { OpLog } from '../../core/log';
import {
  setLocalDataWipeInProgress,
  setLocalDataWipeReloading,
  SKIP_BACKUP_PROMPT_ONCE_KEY,
} from './local-data-wipe-state';

const WIPED_KEYS = [LAST_SYNCED_PROVIDER_KEY, PROFILE_META_KEY];
const WIPED_KEY_PREFIXES = [
  LAST_SERVER_SEQ_KEY_PREFIX,
  FIRST_SYNC_MERGE_DONE_KEY_PREFIX,
  PROFILE_DATA_PREFIX,
];

export type WipeOptions = {
  /** the pending first-sync marker holds the only copy of pre-merge data */
  discardPendingMerge?: boolean;
  /** account switch: committed after the wipe so the reloaded app starts as this user */
  nextSession?: AuthSession;
};

/**
 * Logout / account switch: deletes all local user data and sync state, then reloads
 * so no in-memory state (NgRx, FirstSyncMergeService flags) of the old account survives.
 */
@Injectable({ providedIn: 'root' })
export class LocalDataWipeService {
  private _opLogStore = inject(OperationLogStoreService);
  private _legacyPfDb = inject(LegacyPfDbService);
  private _providerManager = inject(SyncProviderManager);
  private _syncWrapper = inject(SyncWrapperService);
  private _writeFlush = inject(OperationWriteFlushService);
  private _lockService = inject(LockService);
  private _auth = inject(SuperSyncAuthService);

  async wipeAll(opts: WipeOptions = {}): Promise<void> {
    if (
      !opts.discardPendingMerge &&
      (await this._opLogStore.loadFirstSyncMergePending()) !== null
    ) {
      throw new Error('Refusing to wipe: an unfinished first-sync merge is pending');
    }
    this._syncWrapper.disconnectWebSocket();
    // Syncs stay blocked until the reload: the store in memory is the old account's.
    await this._syncWrapper.runWithSyncBlocked(async () => {
      await this._writeFlush.flushPendingWrites();
      // An empty SUP_OPS would otherwise re-migrate legacy 'pf' data (and credentials).
      // First: it is the step that can refuse, before anything in SUP_OPS is gone.
      if (await this._legacyPfDb.databaseExists()) {
        await this._legacyPfDb.clearAll();
        if (await this._legacyPfDb.hasUsableEntityData()) {
          throw new Error('Failed to clear legacy database');
        }
      }
      // From here until the reload: no op capture (except the new session's sync
      // config op), no compaction, no sync. Only reset if SUP_OPS is still intact.
      setLocalDataWipeInProgress(true);
      try {
        await this._lockService.request(LOCK_NAMES.OPERATION_LOG, () =>
          this._opLogStore.clearAllUserData(),
        );
      } catch (e) {
        setLocalDataWipeInProgress(false);
        throw e;
      }
      const keys = Array.from({ length: localStorage.length }, (_, i) =>
        localStorage.key(i),
      ).filter(
        (k): k is string =>
          !!k &&
          (WIPED_KEYS.includes(k) || WIPED_KEY_PREFIXES.some((p) => k.startsWith(p))),
      );
      keys.forEach((k) => localStorage.removeItem(k));
      // the emptied store must not make startup offer a backup restore of the old data
      localStorage.setItem(SKIP_BACKUP_PROMPT_ONCE_KEY, '1');
      // Whole private cfg incl. encryptKey: it belongs to the previous account.
      const superSync = await this._providerManager.getProviderById(
        SyncProviderId.SuperSync,
      );
      await superSync?.privateCfg.clear();

      if (opts.nextSession) {
        await this._auth.commitSession(opts.nextSession);
        await this._writeFlush.flushPendingWrites();
      }
      OpLog.normal('[LocalDataWipe] Local data wiped, reloading', {
        removedKeys: keys.length,
      });
      setLocalDataWipeReloading();
      this._reload();
    });
  }

  private _reload(): void {
    if (IS_ELECTRON) {
      window.ea.reloadMainWin();
    } else {
      window.location.reload();
    }
  }
}
