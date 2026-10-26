import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { AppDataComplete, MODEL_CONFIGS } from '../../model/model-config';
import { OperationSyncCapable } from '../../sync-providers/provider.interface';
import { SuperSyncAuthService } from '../../sync-providers/super-sync/super-sync-auth.service';
import { LAST_SERVER_SEQ_KEY_PREFIX } from '../../sync-providers/super-sync/super-sync';
import { SyncProviderManager } from '../../sync-providers/provider-manager.service';
import { SyncProviderId } from '../../sync-providers/provider.const';
import { OperationLogStoreService } from '../../persistence/operation-log-store.service';
import { OperationLogSyncService } from '../operation-log-sync.service';
import { OperationWriteFlushService } from '../operation-write-flush.service';
import { OperationEncryptionService } from '../operation-encryption.service';
import { StateSnapshotService } from '../../backup/state-snapshot.service';
import { ArchiveOperationHandler } from '../../apply/archive-operation-handler.service';
import { ArchiveDbAdapter } from '../../../core/persistence/archive-db-adapter.service';
import { ArchiveModel } from '../../../features/time-tracking/time-tracking.model';
import { applyFirstSyncMerge } from '../../../root-store/meta/first-sync-merge.actions';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
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
import {
  buildMergePayload,
  diffForFirstSync,
  foldCurrentIntoSnapshot,
  localEditIdsSince,
} from './first-sync-merge';
import { splitFirstSyncMergePayload } from './first-sync-merge-chunks';

/** 'E2E_MISMATCH': error snackbar already shown, caller must not show another one */
export type FirstSyncMergeResult = 'MERGED' | 'CANCELLED' | 'SKIPPED' | 'E2E_MISMATCH';

/** Persisted in IndexedDB (import_backup store) while a merge is in flight. */
export type FirstSyncMergePending = {
  userId: number;
  /** this device's state before the download replaced it */
  local: AppDataComplete;
  /** forceDownloadRemoteState completed */
  downloaded: boolean;
  /** op-log seq when the merge started: remote ops above it come from this download */
  opLogSeqAtStart: number;
};

export const FIRST_SYNC_MERGE_DONE_KEY_PREFIX = 'SUP_FIRST_SYNC_MERGE_DONE_';

const emptyArchive = (): ArchiveModel => ({
  task: { ids: [], entities: {} },
  timeTracking: { project: {}, tag: {} },
  lastTimeTrackingFlush: 0,
});

/** Every store slice at its default, except the device's config (sync settings). */
const defaultStoreData = (): AppDataComplete => {
  const out: Record<string, unknown> = {};
  for (const [key, cfg] of Object.entries(MODEL_CONFIGS)) {
    if (key !== 'globalConfig' && key !== 'archiveYoung' && key !== 'archiveOld') {
      out[key] = cfg.defaultData;
    }
  }
  return out as AppDataComplete;
};

/**
 * The remote state can only be read back from the store in the app session that ran
 * the download: neither the pre-download reset nor forceDownloadRemoteState's reset
 * is persisted, so after a restart the store is the old local cache plus replayed
 * remote ops. Any resume without a download in this session downloads again, and
 * folds in the user's own edits made since the merge started.
 */
export const planFirstSyncResume = (
  downloadedThisSession: boolean,
): { redownload: boolean; foldLocalEdits: boolean } =>
  downloadedThisSession
    ? { redownload: false, foldLocalEdits: false }
    : { redownload: true, foldLocalEdits: true };

/** Any SuperSync account/server this device ever synced with (lastServerSeq > 0). */
const hasAnySuperSyncServerSeq = (): boolean => {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (
      key?.startsWith(LAST_SERVER_SEQ_KEY_PREFIX) &&
      parseInt(localStorage.getItem(key) ?? '0', 10) > 0
    ) {
      return true;
    }
  }
  return false;
};

const isPending = (v: unknown): v is FirstSyncMergePending => {
  const p = v as Partial<FirstSyncMergePending> | null;
  return (
    !!p &&
    typeof p.userId === 'number' &&
    typeof p.downloaded === 'boolean' &&
    typeof p.opLogSeqAtStart === 'number' &&
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
  private _providerManager = inject(SyncProviderManager);
  private _opLogStore = inject(OperationLogStoreService);
  private _opLogSync = inject(OperationLogSyncService);
  private _writeFlush = inject(OperationWriteFlushService);
  private _encryption = inject(OperationEncryptionService);
  private _stateSnapshot = inject(StateSnapshotService);
  private _archiveHandler = inject(ArchiveOperationHandler);
  private _archiveDb = inject(ArchiveDbAdapter);
  private _conflictDialog = inject(ProjectMergeConflictDialogService);
  private _matDialog = inject(MatDialog);
  private _userInputWaitState = inject(UserInputWaitStateService);
  private _snackService = inject(SnackService);
  private _store = inject(Store);

  /**
   * Closed until runIfNeeded has confirmed (this app session) that no merge is
   * pending or required. Background SuperSync paths (immediate upload, WS download)
   * must not touch the server while closed.
   */
  private _isGateOpen = false;

  /** set once the reset + forceDownloadRemoteState ran in THIS app session */
  private _downloadedThisSession = false;

  isFirstSyncMergePendingOrRequired(): boolean {
    return !this._isGateOpen;
  }

  /**
   * Called by SyncWrapperService before every SuperSync sync (under its sync lock).
   * 'SKIPPED' = continue with the normal sync. Errors propagate (pending marker kept).
   */
  async runIfNeeded(provider: OperationSyncCapable): Promise<FirstSyncMergeResult> {
    this._isGateOpen = false;
    const result = await this._runIfNeeded(provider);
    this._isGateOpen = result === 'SKIPPED' || result === 'MERGED';
    return result;
  }

  private async _runIfNeeded(
    provider: OperationSyncCapable,
  ): Promise<FirstSyncMergeResult> {
    const pending = await this._opLogStore.loadFirstSyncMergePending();
    const session = await this._auth.getSession();
    if (pending !== null) {
      await this._resume(provider, pending, session?.userId);
      return 'MERGED';
    }
    if (!session || this._isDone(session.userId)) {
      return 'SKIPPED';
    }
    // lastServerSeq is keyed by token (a re-login resets it), so any stored SuperSync
    // seq and synced ops count too. Synced ops only from ANOTHER provider do not:
    // that device never synced with this account and must still merge.
    // (Unknown last provider = synced before SP_LAST_SYNCED_PROVIDER_ID existed.)
    const lastSynced = this._providerManager.getLastSyncedProviderId();
    if (
      (await provider.getLastServerSeq()) > 0 ||
      hasAnySuperSyncServerSeq() ||
      ((lastSynced === SyncProviderId.SuperSync || lastSynced === null) &&
        (await this._opLogStore.hasSyncedOps()))
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
  ): Promise<FirstSyncMergeResult> {
    const probe = await this._probeRemote(provider);
    if (probe === 'EMPTY') {
      // New account: the normal sync uploads the whole local state (server seeding).
      OpLog.normal('[FirstSyncMerge] Remote account is empty, no merge needed');
      this._markDone(userId);
      return 'SKIPPED';
    }
    if (probe !== 'OK') {
      return probe;
    }
    this._downloadedThisSession = false; // a new merge never reuses an earlier download
    const pending: FirstSyncMergePending = {
      userId,
      local: await this._readStore(),
      downloaded: false,
      opLogSeqAtStart: await this._opLogStore.getLastSeq(),
    };
    await this._opLogStore.saveFirstSyncMergePending(pending);
    OpLog.normal('[FirstSyncMerge] Pending marker saved');
    await this._downloadAndMerge(provider, pending, false);
    return 'MERGED';
  }

  private async _resume(
    provider: OperationSyncCapable,
    raw: unknown,
    sessionUserId: number | undefined,
  ): Promise<void> {
    if (!isPending(raw)) {
      OpLog.err('[FirstSyncMerge] Pending marker has no valid local snapshot');
      throw new Error(
        'First-sync merge could not resume: saved local data is missing or corrupt',
      );
    }
    if (sessionUserId !== undefined && sessionUserId !== raw.userId) {
      OpLog.err('[FirstSyncMerge] Pending merge belongs to another account', {
        pendingUserId: raw.userId,
        sessionUserId,
      });
      throw new Error(
        'First-sync merge could not resume: it was started for a different account',
      );
    }
    OpLog.normal('[FirstSyncMerge] Resuming pending merge', {
      downloaded: raw.downloaded,
    });
    await this._downloadAndMerge(provider, raw, true);
  }

  private async _downloadAndMerge(
    provider: OperationSyncCapable,
    pending: FirstSyncMergePending,
    isResume: boolean,
  ): Promise<void> {
    const plan = isResume
      ? planFirstSyncResume(this._downloadedThisSession)
      : { redownload: true, foldLocalEdits: false };
    if (plan.redownload) {
      this._downloadedThisSession = false;
      const seq = pending.opLogSeqAtStart;
      // Remote ops logged by an earlier (interrupted or previous-session) download
      // would be skipped as "already applied" after the reset below.
      await this._opLogStore.deleteOpsWhere((e) => e.source === 'remote' && e.seq > seq);
      if (plan.foldLocalEdits) {
        // only the user's own edits since the merge started, never replayed remote data
        const touched = localEditIdsSince(
          await this._opLogStore.getOpsAfterSeq(seq),
          seq,
        );
        pending = {
          ...pending,
          local: foldCurrentIntoSnapshot(pending.local, await this._readStore(), touched),
        };
        await this._opLogStore.saveFirstSyncMergePending(pending);
      }
      try {
        // Start from an empty store and empty archives so what we read back is
        // remote-only (forceDownloadRemoteState resets only some slices and only when
        // the server has no full-state op). Local data is in the snapshot.
        await this._archiveDb.saveArchivesAtomic(emptyArchive(), emptyArchive());
        this._store.dispatch(loadAllData({ appDataComplete: defaultStoreData() }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await this._opLogSync.forceDownloadRemoteState(provider);
        await new Promise((resolve) => setTimeout(resolve, 0));
      } catch (e) {
        await this._restoreLocal(pending.local);
        throw e;
      }
      this._downloadedThisSession = true;
      pending = { ...pending, downloaded: true };
      await this._opLogStore.saveFirstSyncMergePending(pending);
    }

    const remote = await this._readStore();
    const { conflicts } = diffForFirstSync(pending.local, remote);
    const choices = conflicts.length ? await this._conflictDialog.open(conflicts) : {};
    const payload = buildMergePayload(pending.local, remote, choices);

    // Nothing else writes the archive on this device; must land before the ops.
    await this._archiveHandler.writeFirstSyncMergeArchive(payload);

    const chunks = splitFirstSyncMergePayload(payload);
    const before = await this._countMergeOps();
    // from here the store is no longer pure remote: any resume must download again
    this._downloadedThisSession = false;
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
    });
  }

  /** Download failed after the reset: show the local snapshot again (marker kept). */
  private async _restoreLocal(local: AppDataComplete): Promise<void> {
    try {
      await this._archiveDb.saveArchivesAtomic(local.archiveYoung, local.archiveOld);
      // keep the current config (this device's sync settings)
      this._store.dispatch(
        loadAllData({
          appDataComplete: {
            ...local,
            globalConfig: undefined,
          } as unknown as AppDataComplete,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      OpLog.normal('[FirstSyncMerge] Restored local snapshot after failed download');
    } catch (e) {
      OpLog.err('[FirstSyncMerge] Could not restore local snapshot', e);
    }
  }

  /**
   * Looks at the first server op. Spec: account E2E without a key here → ask for the
   * key first (a wrong key cancels); E2E on one side only → not supported.
   */
  private async _probeRemote(
    provider: OperationSyncCapable,
  ): Promise<'EMPTY' | 'OK' | 'CANCELLED' | 'E2E_MISMATCH'> {
    const probe = await provider.downloadOps(0, undefined, 1);
    if (!probe.ops.length && probe.latestSeq === 0) {
      return 'EMPTY';
    }
    if (!probe.ops.length) {
      // server has data but returned no op to inspect: take the merge path (the
      // snapshot is persisted; a decrypt failure restores it and surfaces the error)
      return 'OK';
    }
    const firstOp = probe.ops[0].op;
    const isRemoteEncrypted = !!firstOp.isPayloadEncrypted;
    let key = await provider.getEncryptKey?.();
    if (isRemoteEncrypted && !key) {
      key = (await this._promptForKey()) ? await provider.getEncryptKey?.() : undefined;
      if (!key) {
        return 'CANCELLED';
      }
    }
    if (isRemoteEncrypted !== !!key) {
      OpLog.warn('[FirstSyncMerge] E2E mismatch', { isRemoteEncrypted, hasKey: !!key });
      this._snackService.open({
        type: 'ERROR',
        msg: T.F.SYNC.S.FIRST_SYNC_MERGE_E2E_MISMATCH,
      });
      return 'E2E_MISMATCH';
    }
    if (isRemoteEncrypted && key) {
      try {
        await this._encryption.decryptOperations([firstOp], key);
      } catch (e) {
        OpLog.warn('[FirstSyncMerge] Encryption key does not decrypt the remote data');
        return 'CANCELLED';
      }
    }
    return 'OK';
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
