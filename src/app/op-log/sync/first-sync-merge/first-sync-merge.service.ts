import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { AppDataComplete, getDefaultMainModelData } from '../../model/model-config';
import { OperationSyncCapable } from '../../sync-providers/provider.interface';
import { SuperSyncAuthService } from '../../sync-providers/super-sync/super-sync-auth.service';
import { OperationLogStoreService } from '../../persistence/operation-log-store.service';
import { OperationLogSyncService } from '../operation-log-sync.service';
import { OperationWriteFlushService } from '../operation-write-flush.service';
import { StateSnapshotService } from '../../backup/state-snapshot.service';
import { ArchiveOperationHandler } from '../../apply/archive-operation-handler.service';
import { ArchiveDbAdapter } from '../../../core/persistence/archive-db-adapter.service';
import { ArchiveModel } from '../../../features/time-tracking/time-tracking.model';
import { applyFirstSyncMerge } from '../../../root-store/meta/first-sync-merge.actions';
import { ActionType } from '../../core/action-types.enum';
import { ProjectMergeConflictDialogService } from '../../../imex/sync/dialog-project-merge-conflict/project-merge-conflict-dialog.service';
import { UserInputWaitStateService } from '../../../imex/sync/user-input-wait-state.service';
import {
  DialogEnterEncryptionPasswordComponent,
  EnterEncryptionPasswordResult,
} from '../../../imex/sync/dialog-enter-encryption-password/dialog-enter-encryption-password.component';
import { SnackService } from '../../../core/snack/snack.service';
import { T } from '../../../t.const';
import { OpLog } from '../../../core/log';
import { buildMergePayload, diffForFirstSync } from './first-sync-merge';
import { splitFirstSyncMergePayload } from './first-sync-merge-chunks';

export type FirstSyncMergeResult = 'MERGED' | 'CANCELLED' | 'SKIPPED';

/** Persisted in IndexedDB (import_backup store) while a merge is in flight. */
export type FirstSyncMergePending = {
  userId: number;
  /** this device's state before the download replaced it */
  local: AppDataComplete;
  /** forceDownloadRemoteState completed */
  downloaded: boolean;
  /** server had no ops at download time (new account) */
  remoteEmpty: boolean;
};

export const FIRST_SYNC_MERGE_DONE_KEY_PREFIX = 'SUP_FIRST_SYNC_MERGE_DONE_';

const emptyArchive = (): ArchiveModel => ({
  task: { ids: [], entities: {} },
  timeTracking: { project: {}, tag: {} },
  lastTimeTrackingFlush: 0,
});

const isPending = (v: unknown): v is FirstSyncMergePending => {
  const p = v as Partial<FirstSyncMergePending> | null;
  return (
    !!p &&
    typeof p.userId === 'number' &&
    typeof p.downloaded === 'boolean' &&
    !!p.local &&
    !!p.local.project &&
    !!p.local.task &&
    !!p.local.archiveYoung &&
    !!p.local.archiveOld
  );
};

/**
 * SuperSync first login of a device that already has data (spec decision 3/4):
 * download the account, then write this device's data on top by ID.
 * Crash-safe: the local snapshot is persisted before anything is touched and the
 * merge is re-run from it (idempotent) until all merge ops are durably logged.
 */
@Injectable({ providedIn: 'root' })
export class FirstSyncMergeService {
  private _auth = inject(SuperSyncAuthService);
  private _opLogStore = inject(OperationLogStoreService);
  private _opLogSync = inject(OperationLogSyncService);
  private _writeFlush = inject(OperationWriteFlushService);
  private _stateSnapshot = inject(StateSnapshotService);
  private _archiveHandler = inject(ArchiveOperationHandler);
  private _archiveDb = inject(ArchiveDbAdapter);
  private _conflictDialog = inject(ProjectMergeConflictDialogService);
  private _matDialog = inject(MatDialog);
  private _userInputWaitState = inject(UserInputWaitStateService);
  private _snackService = inject(SnackService);
  private _store = inject(Store);

  /**
   * Called by SyncWrapperService before every SuperSync sync (under its sync lock).
   * 'SKIPPED' = continue with the normal sync. Errors propagate (pending marker kept).
   */
  async runIfNeeded(provider: OperationSyncCapable): Promise<FirstSyncMergeResult> {
    const pending = await this._opLogStore.loadFirstSyncMergePending();
    if (pending !== null) {
      await this._resume(provider, pending);
      return 'MERGED';
    }
    const session = await this._auth.getSession();
    if (!session || this._isDone(session.userId)) {
      return 'SKIPPED';
    }
    // lastServerSeq is keyed by token, so a re-login resets it: hasSyncedOps catches
    // devices that synced before this deploy.
    if (
      (await provider.getLastServerSeq()) > 0 ||
      (await this._opLogStore.hasSyncedOps())
    ) {
      this._markDone(session.userId);
      return 'SKIPPED';
    }
    if (!this._opLogSync.hasMeaningfulLocalData()) {
      return 'SKIPPED';
    }
    return this.run(provider, session.userId);
  }

  async run(
    provider: OperationSyncCapable,
    userId: number,
  ): Promise<'MERGED' | 'CANCELLED'> {
    if (!(await this._checkEncryption(provider))) {
      return 'CANCELLED';
    }
    const pending: FirstSyncMergePending = {
      userId,
      local: await this._readStore(),
      downloaded: false,
      remoteEmpty: false,
    };
    await this._opLogStore.saveFirstSyncMergePending(pending);
    OpLog.normal('[FirstSyncMerge] Pending marker saved');
    await this._downloadAndMerge(provider, pending);
    return 'MERGED';
  }

  private async _resume(provider: OperationSyncCapable, raw: unknown): Promise<void> {
    if (!isPending(raw)) {
      OpLog.err('[FirstSyncMerge] Pending marker has no valid local snapshot');
      throw new Error(
        'First-sync merge could not resume: saved local data is missing or corrupt',
      );
    }
    OpLog.normal('[FirstSyncMerge] Resuming pending merge', {
      downloaded: raw.downloaded,
    });
    await this._downloadAndMerge(provider, raw);
  }

  private async _downloadAndMerge(
    provider: OperationSyncCapable,
    pending: FirstSyncMergePending,
  ): Promise<void> {
    if (!pending.downloaded) {
      // Empty the archive stores so what we read back afterwards is remote-only;
      // this device's archive is in the snapshot and comes back via the payload.
      await this._archiveDb.saveArchivesAtomic(emptyArchive(), emptyArchive());
      await this._opLogSync.forceDownloadRemoteState(provider);
      await new Promise((resolve) => setTimeout(resolve, 0));
      pending = {
        ...pending,
        downloaded: true,
        // forceDownloadRemoteState leaves lastServerSeq at 0 only for an empty server
        remoteEmpty: (await provider.getLastServerSeq()) === 0,
      };
      await this._opLogStore.saveFirstSyncMergePending(pending);
    }

    // Empty account: the store still holds local data, so compare against defaults.
    const remote: AppDataComplete = pending.remoteEmpty
      ? ({
          ...getDefaultMainModelData(),
          archiveYoung: emptyArchive(),
          archiveOld: emptyArchive(),
        } as AppDataComplete)
      : await this._readStore();

    const { conflicts } = diffForFirstSync(pending.local, remote);
    const choices = conflicts.length ? await this._conflictDialog.open(conflicts) : {};
    const payload = buildMergePayload(pending.local, remote, choices);

    // Nothing else writes the archive on this device; must land before the ops.
    await this._archiveHandler.writeFirstSyncMergeArchive(payload);

    const chunks = splitFirstSyncMergePayload(payload);
    const before = await this._countMergeOps();
    for (const chunk of chunks) {
      this._store.dispatch(applyFirstSyncMerge({ payload: chunk }));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this._writeFlush.flushPendingWrites();
    // The op-log effect swallows write errors, so verify the ops really are in IndexedDB.
    const written = (await this._countMergeOps()) - before;
    if (written < chunks.length) {
      OpLog.err('[FirstSyncMerge] Merge ops not persisted', {
        written,
        expected: chunks.length,
      });
      throw new Error(
        `First-sync merge: only ${written} of ${chunks.length} operations were saved`,
      );
    }

    await this._opLogStore.clearFirstSyncMergePending();
    this._markDone(pending.userId);
    OpLog.normal('[FirstSyncMerge] Merge complete', {
      conflicts: conflicts.length,
      chunks: chunks.length,
      remoteEmpty: pending.remoteEmpty,
    });
  }

  /**
   * Spec: account E2E without a key here → ask for the key first; E2E on one side
   * only → not supported. Probes the first server op (encryption resets the server).
   */
  private async _checkEncryption(provider: OperationSyncCapable): Promise<boolean> {
    const probe = await provider.downloadOps(0, undefined, 1);
    if (!probe.ops.length) {
      return true;
    }
    const isRemoteEncrypted = !!probe.ops[0].op.isPayloadEncrypted;
    let hasKey = !!(await provider.getEncryptKey?.());
    if (isRemoteEncrypted && !hasKey) {
      hasKey = await this._promptForKey();
      if (!hasKey) {
        return false;
      }
    }
    if (isRemoteEncrypted !== hasKey) {
      OpLog.warn('[FirstSyncMerge] E2E mismatch', { isRemoteEncrypted, hasKey });
      this._snackService.open({
        type: 'ERROR',
        msg: T.F.SYNC.S.FIRST_SYNC_MERGE_E2E_MISMATCH,
      });
      return false;
    }
    return true;
  }

  // shortcut: the dialog's force-overwrite button waits for the sync we are inside
  // (runWithSyncBlocked) and times out; any result without a password is a cancel.
  private async _promptForKey(): Promise<boolean> {
    const stopWaiting = this._userInputWaitState.startWaiting('first-sync-merge-key');
    try {
      const ref = this._matDialog.open<
        DialogEnterEncryptionPasswordComponent,
        unknown,
        EnterEncryptionPasswordResult
      >(DialogEnterEncryptionPasswordComponent, { width: '450px', disableClose: true });
      const res = await firstValueFrom(ref.afterClosed());
      return !!res?.password;
    } finally {
      stopWaiting();
    }
  }

  private async _readStore(): Promise<AppDataComplete> {
    return (await this._stateSnapshot.getAllSyncModelDataFromStoreAsync()) as AppDataComplete;
  }

  private async _countMergeOps(): Promise<number> {
    return (await this._opLogStore.getUnsynced()).filter(
      (e) => e.op.actionType === ActionType.SYNC_APPLY_FIRST_SYNC_MERGE,
    ).length;
  }

  private _isDone(userId: number): boolean {
    return localStorage.getItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + userId) === '1';
  }

  private _markDone(userId: number): void {
    localStorage.setItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + userId, '1');
  }
}
