import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { filter, first, timeout } from 'rxjs/operators';
import {
  AuthSession,
  SuperSyncAuthService,
} from '../../op-log/sync-providers/super-sync/super-sync-auth.service';
import { LocalDataWipeService } from '../../op-log/persistence/local-data-wipe.service';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { OperationWriteFlushService } from '../../op-log/sync/operation-write-flush.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { BackupService } from '../../op-log/backup/backup.service';
import { CROSS_MODEL_VERSION } from '../../op-log/model/model-config';
import { DialogConfirmComponent } from '../../ui/dialog-confirm/dialog-confirm.component';
import { isOnline } from '../../util/is-online';
import { download } from '../../util/download';
import {
  BACKUP_FILENAME_PREFIX,
  getBackupTimestamp,
} from '../../../../electron/shared-with-frontend/get-backup-timestamp';
import { T } from '../../t.const';
import { SyncProviderManager } from '../../op-log/sync-providers/provider-manager.service';
import { SyncProviderId, SyncStatus } from '../../op-log/sync-providers/provider.const';
import { LAST_SERVER_SEQ_KEY_PREFIX } from '../../op-log/sync-providers/super-sync/super-sync';
import { FIRST_SYNC_MERGE_DONE_KEY_PREFIX } from '../../op-log/sync/first-sync-merge/first-sync-merge.service';
import { Log } from '../log';
import { ActionType } from '../../op-log/core/action-types.enum';

export type AccountSessionResult = 'DONE' | 'CANCELLED';

const READY_TIMEOUT_MS = 30_000;

const normalizeUrl = (u: string): string => u.replace(/\/+$/, '');

/**
 * Logout and account switch: push what is left (sync), then wipe local data.
 * Unsynced changes or an unfinished first-sync merge are only dropped after the user
 * confirmed (with the option to download a backup first).
 */
@Injectable({ providedIn: 'root' })
export class AccountSessionService {
  private _auth = inject(SuperSyncAuthService);
  private _wipe = inject(LocalDataWipeService);
  private _opLogStore = inject(OperationLogStoreService);
  private _writeFlush = inject(OperationWriteFlushService);
  private _syncWrapper = inject(SyncWrapperService);
  private _backup = inject(BackupService);
  private _matDialog = inject(MatDialog);
  private _providerManager = inject(SyncProviderManager);

  logout(): Promise<AccountSessionResult> {
    return this._flushConfirmWipe();
  }

  async completeLogin(s: AuthSession): Promise<AccountSessionResult> {
    const change = await this._accountChange(s);
    if (change !== 'SAME') {
      return this._flushConfirmWipe(s, change === 'UNKNOWN');
    }
    // Same account or none: keep local data; the first sync runs the first-sync merge
    // if needed. Background upload/WS stay gated until that sync, so start it now.
    await this._auth.commitSession(s);
    void this._syncWhenReady();
    return 'DONE';
  }

  private async _flushConfirmWipe(
    nextSession?: AuthSession,
    isPreviousAccountUnknown = false,
  ): Promise<AccountSessionResult> {
    // A pending merge is checked before syncing: sync() would resume it.
    let isServerCopyVerified = false;
    if ((await this._opLogStore.loadFirstSyncMergePending()) === null && isOnline()) {
      try {
        isServerCopyVerified = (await this._syncWrapper.sync()) === SyncStatus.InSync;
      } catch (e) {
        Log.warn('[AccountSession] Sync before wipe failed');
      }
    }
    const pending = await this._opLogStore.loadFirstSyncMergePending();
    if (pending !== null) {
      const local = (pending as { local?: unknown }).local;
      const isConfirmed = await this._confirm(T.F.SYNC.ACCOUNT.D_PENDING_MERGE_MSG, () =>
        local
          ? Promise.resolve({
              timestamp: Date.now(),
              lastUpdate: Date.now(),
              crossModelVersion: CROSS_MODEL_VERSION,
              data: local,
            })
          : this._backup.loadCompleteBackup(true),
      );
      if (!isConfirmed) {
        return 'CANCELLED';
      }
      await this._wipe.wipeAll({ discardPendingMerge: true, nextSession });
      return 'DONE';
    }

    await this._writeFlush.flushPendingWrites();
    const count = (await this._opLogStore.getUnsynced()).length;
    // A rejected first-sync merge op never reached the server and is not "unsynced".
    const hasRejectedMerge = await this._opLogStore.hasRejectedOpOfType(
      ActionType.SYNC_APPLY_FIRST_SYNC_MERGE,
    );
    // Only a known account whose server copy was just confirmed (InSync, nothing
    // unsynced, no rejected merge) is wiped without asking.
    const isConfirmNeeded =
      count > 0 || isPreviousAccountUnknown || !isServerCopyVerified || hasRejectedMerge;
    if (
      isConfirmNeeded &&
      !(await this._confirm(
        count > 0 ? T.F.SYNC.ACCOUNT.D_UNSYNCED_MSG : T.F.SYNC.ACCOUNT.D_UNVERIFIED_MSG,
        () => this._backup.loadCompleteBackup(true),
        { count },
      ))
    ) {
      Log.log('[AccountSession] Wipe cancelled', {
        unsyncedCount: count,
        hasRejectedMerge,
        isPreviousAccountUnknown,
        isServerCopyVerified,
      });
      return 'CANCELLED';
    }
    await this._wipe.wipeAll({ nextSession });
    return 'DONE';
  }

  /** Account identity is (baseUrl, userId). */
  private async _accountChange(s: AuthSession): Promise<'SAME' | 'CHANGED' | 'UNKNOWN'> {
    const cfg = await this._providerManager.getProviderConfig(SyncProviderId.SuperSync);
    // A token without baseUrl: the server is unknown, never assume the upstream one.
    if (cfg?.accessToken && !cfg.baseUrl) {
      return 'UNKNOWN';
    }
    if (cfg?.baseUrl && normalizeUrl(cfg.baseUrl) !== normalizeUrl(s.baseUrl)) {
      return 'CHANGED';
    }
    const previous = await this._previousUserId(cfg);
    if (previous === 'UNKNOWN') {
      return 'UNKNOWN';
    }
    return previous !== null && previous !== s.userId ? 'CHANGED' : 'SAME';
  }

  /**
   * The account this device's data belongs to. Without a session (the token is cleared
   * after repeated 401s) the pending marker or a single done marker still tell; any
   * other sign of earlier SuperSync use makes it 'UNKNOWN'. null = no SuperSync history.
   */
  private async _previousUserId(
    cfg: { encryptKey?: string; isEncryptionEnabled?: boolean } | null,
  ): Promise<number | 'UNKNOWN' | null> {
    const session = await this._auth.getSession();
    if (session) {
      return session.userId;
    }
    const pending = (await this._opLogStore.loadFirstSyncMergePending()) as {
      userId?: unknown;
    } | null;
    if (typeof pending?.userId === 'number') {
      return pending.userId;
    }
    const doneIds = new Set<number>();
    let hasServerSeq = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? '';
      if (key.startsWith(FIRST_SYNC_MERGE_DONE_KEY_PREFIX)) {
        doneIds.add(parseInt(key.slice(FIRST_SYNC_MERGE_DONE_KEY_PREFIX.length), 10));
      } else if (
        key.startsWith(LAST_SERVER_SEQ_KEY_PREFIX) &&
        parseInt(localStorage.getItem(key) ?? '0', 10) > 0
      ) {
        hasServerSeq = true;
      }
    }
    if (doneIds.size === 1) {
      const [id] = doneIds;
      return isNaN(id) ? 'UNKNOWN' : id;
    }
    if (
      doneIds.size > 1 ||
      hasServerSeq ||
      !!cfg?.encryptKey ||
      !!cfg?.isEncryptionEnabled ||
      (this._providerManager.getLastSyncedProviderId() === SyncProviderId.SuperSync &&
        (await this._opLogStore.hasSyncedOps()))
    ) {
      return 'UNKNOWN';
    }
    return null;
  }

  /** Loops until the user deletes (true) or cancels (false); 'EXTRA' downloads a backup. */
  private async _confirm(
    message: string,
    loadBackup: () => Promise<unknown>,
    translateParams?: Record<string, unknown>,
  ): Promise<boolean> {
    for (;;) {
      const res = await firstValueFrom(
        this._matDialog
          .open(DialogConfirmComponent, {
            restoreFocus: true,
            data: {
              title: T.F.SYNC.ACCOUNT.D_TITLE,
              message,
              translateParams,
              okTxt: T.F.SYNC.ACCOUNT.BTN_DELETE,
              extraTxt: T.F.SYNC.ACCOUNT.BTN_DOWNLOAD_BACKUP,
            },
          })
          .afterClosed(),
      );
      if (res !== 'EXTRA') {
        return res === true;
      }
      await this._download(await loadBackup());
    }
  }

  private async _download(data: unknown): Promise<void> {
    await download(
      `${BACKUP_FILENAME_PREFIX}_${getBackupTimestamp()}.json`,
      JSON.stringify(data),
    );
  }

  private async _syncWhenReady(): Promise<void> {
    try {
      await firstValueFrom(
        this._syncWrapper.isEnabledAndReady$.pipe(
          filter(Boolean),
          first(),
          timeout(READY_TIMEOUT_MS),
        ),
      );
      await this._syncWrapper.sync();
    } catch (e) {
      Log.warn('[AccountSession] Sync after login did not run');
    }
  }
}
