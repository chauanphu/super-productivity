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
import { Log } from '../log';

export type AccountSessionResult = 'DONE' | 'CANCELLED';

const READY_TIMEOUT_MS = 30_000;

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

  logout(): Promise<AccountSessionResult> {
    return this._flushConfirmWipe();
  }

  async completeLogin(s: AuthSession): Promise<AccountSessionResult> {
    const current = await this._auth.getSession();
    if (current && current.userId !== s.userId) {
      return this._flushConfirmWipe(s);
    }
    // Same account or none: keep local data; the first sync runs the first-sync merge
    // if needed. Background upload/WS stay gated until that sync, so start it now.
    await this._auth.commitSession(s);
    void this._syncWhenReady();
    return 'DONE';
  }

  private async _flushConfirmWipe(
    nextSession?: AuthSession,
  ): Promise<AccountSessionResult> {
    // A pending merge is checked before syncing: sync() would resume it.
    if ((await this._opLogStore.loadFirstSyncMergePending()) === null && isOnline()) {
      try {
        await this._syncWrapper.sync();
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
    if (
      count > 0 &&
      !(await this._confirm(
        T.F.SYNC.ACCOUNT.D_UNSYNCED_MSG,
        () => this._backup.loadCompleteBackup(true),
        { count },
      ))
    ) {
      Log.log('[AccountSession] Wipe cancelled', { unsyncedCount: count });
      return 'CANCELLED';
    }
    await this._wipe.wipeAll({ nextSession });
    return 'DONE';
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
