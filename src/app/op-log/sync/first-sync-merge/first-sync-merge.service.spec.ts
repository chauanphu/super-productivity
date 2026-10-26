import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import {
  FIRST_SYNC_MERGE_DONE_KEY_PREFIX,
  FirstSyncMergePending,
  FirstSyncMergeService,
  planFirstSyncResume,
} from './first-sync-merge.service';
import { SuperSyncAuthService } from '../../sync-providers/super-sync/super-sync-auth.service';
import { OperationLogStoreService } from '../../persistence/operation-log-store.service';
import { OperationLogSyncService } from '../operation-log-sync.service';
import { OperationWriteFlushService } from '../operation-write-flush.service';
import { StateSnapshotService } from '../../backup/state-snapshot.service';
import { ArchiveOperationHandler } from '../../apply/archive-operation-handler.service';
import { ArchiveDbAdapter } from '../../../core/persistence/archive-db-adapter.service';
import { ProjectMergeConflictDialogService } from '../../../imex/sync/dialog-project-merge-conflict/project-merge-conflict-dialog.service';
import { UserInputWaitStateService } from '../../../imex/sync/user-input-wait-state.service';
import { SnackService } from '../../../core/snack/snack.service';
import { OperationSyncCapable } from '../../sync-providers/provider.interface';
import { AppDataComplete } from '../../model/model-config';
import { createAppDataCompleteMock } from '../../../util/app-data-mock';
import { DEFAULT_TASK, Task } from '../../../features/tasks/task.model';
import { INBOX_PROJECT } from '../../../features/project/project.const';
import { Project } from '../../../features/project/project.model';
import { applyFirstSyncMerge } from '../../../root-store/meta/first-sync-merge.actions';
import { ActionType } from '../../core/action-types.enum';
import { T } from '../../../t.const';
import { FirstSyncMergePayload } from './first-sync-merge';
import { SyncProviderManager } from '../../sync-providers/provider-manager.service';
import { SyncProviderId } from '../../sync-providers/provider.const';
import { OperationEncryptionService } from '../operation-encryption.service';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import { OperationLogEntry } from '../../core/operation.types';

const USER_ID = 42;

const task = (id: string, p: Partial<Task> = {}): Task => ({
  ...DEFAULT_TASK,
  created: 1,
  id,
  title: id,
  projectId: INBOX_PROJECT.id,
  ...p,
});
const project = (id: string, p: Partial<Project> = {}): Project => ({
  ...INBOX_PROJECT,
  id,
  title: id,
  taskIds: [],
  backlogTaskIds: [],
  noteIds: [],
  ...p,
});
const entities = <X extends { id: string }>(
  items: X[],
): { ids: string[]; entities: Record<string, X> } => ({
  ids: items.map((i) => i.id),
  entities: Object.fromEntries(items.map((i) => [i.id, i])),
});
const data = (projects: Project[], tasks: Task[] = []): AppDataComplete => {
  const m = createAppDataCompleteMock();
  return {
    ...m,
    project: entities(projects),
    task: { ...m.task, ...entities(tasks) },
  };
};

describe('FirstSyncMergeService', () => {
  let service: FirstSyncMergeService;
  let calls: string[];
  let storeState: AppDataComplete;
  let remoteState: AppDataComplete;
  let pendingInDb: unknown;
  let dispatched: FirstSyncMergePayload[];
  let persistOps: boolean;
  let lastServerSeq: number;

  let auth: jasmine.SpyObj<SuperSyncAuthService>;
  let opLogStore: jasmine.SpyObj<OperationLogStoreService>;
  let opLogSync: jasmine.SpyObj<OperationLogSyncService>;
  let archiveHandler: jasmine.SpyObj<ArchiveOperationHandler>;
  let archiveDb: jasmine.SpyObj<ArchiveDbAdapter>;
  let conflictDialog: jasmine.SpyObj<ProjectMergeConflictDialogService>;
  let matDialog: jasmine.SpyObj<MatDialog>;
  let snack: jasmine.SpyObj<SnackService>;
  let provider: jasmine.SpyObj<OperationSyncCapable>;
  let encryptKey: string | undefined;
  let remoteOps: { op: { isPayloadEncrypted?: boolean } }[];
  let latestSeq: number;
  let opsAfterSeq: OperationLogEntry[];
  let lastSyncedProvider: SyncProviderId | null;
  let encryption: jasmine.SpyObj<OperationEncryptionService>;
  let deletePredicate: ((e: OperationLogEntry) => boolean) | undefined;

  beforeEach(() => {
    calls = [];
    dispatched = [];
    pendingInDb = null;
    persistOps = true;
    lastServerSeq = 0;
    encryptKey = undefined;
    remoteOps = [{ op: {} }];
    latestSeq = 1;
    opsAfterSeq = [];
    lastSyncedProvider = null;
    deletePredicate = undefined;
    storeState = data([project('pLocal')], [task('t1', { projectId: 'pLocal' })]);
    remoteState = data([project('pRemote')]);

    auth = jasmine.createSpyObj('SuperSyncAuthService', ['getSession']);
    auth.getSession.and.resolveTo({ userId: USER_ID, email: 'a@b.c' });

    opLogStore = jasmine.createSpyObj('OperationLogStoreService', [
      'loadFirstSyncMergePending',
      'saveFirstSyncMergePending',
      'clearFirstSyncMergePending',
      'hasSyncedOps',
      'getUnsynced',
      'getLastSeq',
      'deleteOpsWhere',
      'getOpsAfterSeq',
    ]);
    opLogStore.getOpsAfterSeq.and.callFake(async () => opsAfterSeq);
    opLogStore.getLastSeq.and.resolveTo(100);
    opLogStore.deleteOpsWhere.and.callFake(async (pred) => {
      calls.push('deleteRemoteOps');
      deletePredicate = pred;
    });
    opLogStore.loadFirstSyncMergePending.and.callFake(async () => pendingInDb);
    opLogStore.saveFirstSyncMergePending.and.callFake(async (p) => {
      calls.push(`savePending:${(p as FirstSyncMergePending).downloaded}`);
      pendingInDb = p;
    });
    opLogStore.clearFirstSyncMergePending.and.callFake(async () => {
      calls.push('clearPending');
      pendingInDb = null;
    });
    opLogStore.hasSyncedOps.and.resolveTo(false);
    opLogStore.getUnsynced.and.callFake(
      async () =>
        dispatched.map(() => ({
          op: { actionType: ActionType.SYNC_APPLY_FIRST_SYNC_MERGE },
        })) as never,
    );

    opLogSync = jasmine.createSpyObj('OperationLogSyncService', [
      'hasMeaningfulLocalData',
      'forceDownloadRemoteState',
    ]);
    opLogSync.hasMeaningfulLocalData.and.returnValue(true);
    opLogSync.forceDownloadRemoteState.and.callFake(async () => {
      calls.push('forceDownload');
      storeState = remoteState;
      lastServerSeq = remoteOps.length ? 7 : 0;
    });

    const flush = jasmine.createSpyObj('OperationWriteFlushService', [
      'flushPendingWrites',
    ]);
    flush.flushPendingWrites.and.callFake(async () => {
      calls.push('flush');
    });
    const snapshot = jasmine.createSpyObj('StateSnapshotService', [
      'getAllSyncModelDataFromStoreAsync',
    ]);
    snapshot.getAllSyncModelDataFromStoreAsync.and.callFake(async () => storeState);

    archiveHandler = jasmine.createSpyObj('ArchiveOperationHandler', [
      'writeFirstSyncMergeArchive',
    ]);
    archiveHandler.writeFirstSyncMergeArchive.and.callFake(async () => {
      calls.push('archiveWrite');
    });
    archiveDb = jasmine.createSpyObj('ArchiveDbAdapter', ['saveArchivesAtomic']);
    archiveDb.saveArchivesAtomic.and.callFake(async () => {
      calls.push('archiveReset');
    });

    conflictDialog = jasmine.createSpyObj('ProjectMergeConflictDialogService', ['open']);
    matDialog = jasmine.createSpyObj('MatDialog', ['open']);
    const waitState = jasmine.createSpyObj('UserInputWaitStateService', ['startWaiting']);
    waitState.startWaiting.and.returnValue(() => undefined);
    snack = jasmine.createSpyObj('SnackService', ['open']);
    const store = jasmine.createSpyObj('Store', ['dispatch']);
    store.dispatch.and.callFake((a: ReturnType<typeof applyFirstSyncMerge>) => {
      if ((a as { type: string }).type === loadAllData.type) {
        calls.push('resetStore');
        return;
      }
      calls.push('dispatch');
      if (persistOps) {
        dispatched.push(a.payload);
      }
    });
    encryption = jasmine.createSpyObj('OperationEncryptionService', [
      'decryptOperations',
    ]);
    encryption.decryptOperations.and.resolveTo([]);
    const providerManager = jasmine.createSpyObj('SyncProviderManager', [
      'getLastSyncedProviderId',
    ]);
    providerManager.getLastSyncedProviderId.and.callFake(() => lastSyncedProvider);

    provider = jasmine.createSpyObj('OperationSyncCapable', [
      'getLastServerSeq',
      'downloadOps',
      'getEncryptKey',
    ]);
    provider.getLastServerSeq.and.callFake(async () => lastServerSeq);
    provider.downloadOps.and.callFake(
      async () => ({ ops: remoteOps, latestSeq }) as never,
    );
    (provider.getEncryptKey as jasmine.Spy).and.callFake(async () => encryptKey);

    TestBed.configureTestingModule({
      providers: [
        FirstSyncMergeService,
        { provide: SuperSyncAuthService, useValue: auth },
        { provide: OperationLogStoreService, useValue: opLogStore },
        { provide: OperationLogSyncService, useValue: opLogSync },
        { provide: OperationWriteFlushService, useValue: flush },
        { provide: StateSnapshotService, useValue: snapshot },
        { provide: ArchiveOperationHandler, useValue: archiveHandler },
        { provide: ArchiveDbAdapter, useValue: archiveDb },
        { provide: ProjectMergeConflictDialogService, useValue: conflictDialog },
        { provide: MatDialog, useValue: matDialog },
        { provide: UserInputWaitStateService, useValue: waitState },
        { provide: SnackService, useValue: snack },
        { provide: Store, useValue: store },
        { provide: OperationEncryptionService, useValue: encryption },
        { provide: SyncProviderManager, useValue: providerManager },
      ],
    });
    service = TestBed.inject(FirstSyncMergeService);
    localStorage.removeItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + USER_ID);
  });

  afterEach(() => localStorage.removeItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + USER_ID));

  const isDone = (): boolean =>
    localStorage.getItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + USER_ID) === '1';
  const allDispatched = (): FirstSyncMergePayload =>
    ({
      projects: dispatched.flatMap((p) => p.projects),
      tasks: dispatched.flatMap((p) => p.tasks),
    }) as FirstSyncMergePayload;

  const pendingRecord = (
    p: Partial<FirstSyncMergePending> = {},
  ): FirstSyncMergePending => ({
    userId: USER_ID,
    local: data([project('pLocal')], [task('t1', { projectId: 'pLocal' })]),
    downloaded: true,
    opLogSeqAtStart: 50,
    ...p,
  });

  describe('runIfNeeded (trigger)', () => {
    it('merges when SuperSync device has data and never synced with this account', async () => {
      expect(await service.runIfNeeded(provider)).toBe('MERGED');
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalled();
      expect(isDone()).toBeTrue();
    });

    it('skips when the done marker for this user exists', async () => {
      localStorage.setItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + USER_ID, '1');
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(opLogSync.forceDownloadRemoteState).not.toHaveBeenCalled();
    });

    it('skips and sets the done marker when lastServerSeq > 0', async () => {
      lastServerSeq = 3;
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(isDone()).toBeTrue();
      expect(opLogSync.forceDownloadRemoteState).not.toHaveBeenCalled();
    });

    it('skips and sets the done marker when the device synced ops with SuperSync', async () => {
      opLogStore.hasSyncedOps.and.resolveTo(true);
      lastSyncedProvider = SyncProviderId.SuperSync;
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(isDone()).toBeTrue();
    });

    it('still merges when the synced ops came from another provider', async () => {
      opLogStore.hasSyncedOps.and.resolveTo(true);
      lastSyncedProvider = SyncProviderId.Dropbox;
      expect(await service.runIfNeeded(provider)).toBe('MERGED');
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalled();
    });

    it('remote returns no op but latestSeq > 0: treated as non-empty, merges', async () => {
      remoteOps = [];
      latestSeq = 5;
      expect(await service.runIfNeeded(provider)).toBe('MERGED');
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalled();
    });

    it('skips when any SuperSync lastServerSeq key in localStorage is > 0', async () => {
      localStorage.setItem('super_sync_last_server_seq_test', '4');
      try {
        expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
        expect(isDone()).toBeTrue();
      } finally {
        localStorage.removeItem('super_sync_last_server_seq_test');
      }
    });

    it('skips when the device has synced ops and the last provider is unknown', async () => {
      opLogStore.hasSyncedOps.and.resolveTo(true);
      lastSyncedProvider = null;
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(isDone()).toBeTrue();
    });

    it('skips without marking done when there is no meaningful local data', async () => {
      opLogSync.hasMeaningfulLocalData.and.returnValue(false);
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(isDone()).toBeFalse();
      expect(opLogSync.forceDownloadRemoteState).not.toHaveBeenCalled();
    });

    it('skips when there is no session', async () => {
      auth.getSession.and.resolveTo(null);
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(opLogSync.forceDownloadRemoteState).not.toHaveBeenCalled();
    });

    it('empty remote account: no merge, done marker set, SKIPPED', async () => {
      remoteOps = [];
      latestSeq = 0;
      expect(await service.runIfNeeded(provider)).toBe('SKIPPED');
      expect(isDone()).toBeTrue();
      expect(calls).toEqual([]);
      expect(pendingInDb).toBeNull();
    });
  });

  describe('background gate (isFirstSyncMergePendingOrRequired)', () => {
    it('is closed before the first check of this app session', () => {
      expect(service.isFirstSyncMergePendingOrRequired()).toBeTrue();
    });

    it('opens when nothing is needed', async () => {
      localStorage.setItem(FIRST_SYNC_MERGE_DONE_KEY_PREFIX + USER_ID, '1');
      await service.runIfNeeded(provider);
      expect(service.isFirstSyncMergePendingOrRequired()).toBeFalse();
    });

    it('opens after a successful merge', async () => {
      await service.runIfNeeded(provider);
      expect(service.isFirstSyncMergePendingOrRequired()).toBeFalse();
    });

    it('stays closed when the merge is cancelled', async () => {
      remoteOps = [{ op: { isPayloadEncrypted: true } }];
      matDialog.open.and.returnValue({ afterClosed: () => of({}) } as never);
      expect(await service.runIfNeeded(provider)).toBe('CANCELLED');
      expect(service.isFirstSyncMergePendingOrRequired()).toBeTrue();
    });

    it('stays closed when the merge fails (pending marker kept)', async () => {
      archiveHandler.writeFirstSyncMergeArchive.and.rejectWith(new Error('idb'));
      await expectAsync(service.runIfNeeded(provider)).toBeRejected();
      expect(service.isFirstSyncMergePendingOrRequired()).toBeTrue();
    });
  });

  describe('run', () => {
    it('without conflicts: no dialog, ordered steps, MERGED', async () => {
      expect(await service.run(provider, USER_ID)).toBe('MERGED');
      expect(conflictDialog.open).not.toHaveBeenCalled();
      expect(calls).toEqual([
        'savePending:false',
        'deleteRemoteOps',
        'archiveReset',
        'resetStore',
        'forceDownload',
        'savePending:true',
        'archiveWrite',
        'dispatch',
        'flush',
        'clearPending',
      ]);
      // local snapshot (taken before download) was merged onto remote
      expect(allDispatched().projects.map((p) => p.id)).toEqual(['pLocal']);
      expect(allDispatched().tasks.map((t) => t.id)).toEqual(['t1']);
      expect((pendingInDb as FirstSyncMergePending | null) ?? null).toBeNull();
      expect(isDone()).toBeTrue();
    });

    it('dispatches one action per chunk in order', async () => {
      const many = Array.from({ length: 800 }, (_, i) =>
        task(`t${String(i).padStart(4, '0')}`, { projectId: 'pLocal' }),
      );
      storeState = data([project('pLocal')], many);
      await service.run(provider, USER_ID);
      expect(dispatched.length).toBeGreaterThan(1);
      expect(allDispatched().tasks.map((t) => t.id)).toEqual(many.map((t) => t.id));
      const firstDispatch = calls.indexOf('dispatch');
      expect(calls.indexOf('archiveWrite')).toBeLessThan(firstDispatch);
      expect(calls.lastIndexOf('dispatch')).toBeLessThan(calls.indexOf('clearPending'));
    });

    it('passes dialog choices into the payload', async () => {
      storeState = data([project('p1', { title: 'local title' })]);
      remoteState = data([project('p1', { title: 'remote title' })]);
      conflictDialog.open.and.resolveTo({ p1: 'LOCAL' });
      await service.run(provider, USER_ID);
      expect(conflictDialog.open).toHaveBeenCalledWith([
        { projectId: 'p1', title: 'local title' },
      ]);
      expect(allDispatched().projects.map((p) => p.title)).toEqual(['local title']);
    });

    it('keeps remote version when REMOTE is chosen', async () => {
      storeState = data([project('p1', { title: 'local title' })]);
      remoteState = data([project('p1', { title: 'remote title' })]);
      conflictDialog.open.and.resolveTo({ p1: 'REMOTE' });
      await service.run(provider, USER_ID);
      expect(allDispatched().projects.map((p) => p.id)).not.toContain('p1');
    });

    it('E2E on device only: snackbar, E2E_MISMATCH, nothing touched', async () => {
      encryptKey = 'k';
      expect(await service.run(provider, USER_ID)).toBe('E2E_MISMATCH');
      expect(snack.open).toHaveBeenCalledWith(
        jasmine.objectContaining({ msg: T.F.SYNC.S.FIRST_SYNC_MERGE_E2E_MISMATCH }),
      );
      expect(calls).toEqual([]);
    });

    it('remote encrypted, no key, user aborts the prompt: CANCELLED, nothing touched', async () => {
      remoteOps = [{ op: { isPayloadEncrypted: true } }];
      matDialog.open.and.returnValue({ afterClosed: () => of({}) } as never);
      expect(await service.run(provider, USER_ID)).toBe('CANCELLED');
      expect(calls).toEqual([]);
    });

    it('remote encrypted, user enters the key: merge proceeds', async () => {
      remoteOps = [{ op: { isPayloadEncrypted: true } }];
      matDialog.open.and.callFake((() => {
        encryptKey = 'pw'; // the dialog saves the key in the provider config
        return { afterClosed: () => of({ password: 'pw' }) };
      }) as never);
      expect(await service.run(provider, USER_ID)).toBe('MERGED');
      expect(encryption.decryptOperations).toHaveBeenCalled();
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalled();
    });

    it('wrong key (probed op does not decrypt): CANCELLED, nothing touched', async () => {
      remoteOps = [{ op: { isPayloadEncrypted: true } }];
      encryptKey = 'wrong';
      encryption.decryptOperations.and.rejectWith(new Error('decrypt'));
      expect(await service.run(provider, USER_ID)).toBe('CANCELLED');
      expect(calls).toEqual([]);
    });

    it('archive write failure: rejects, no dispatch, marker kept, not done', async () => {
      archiveHandler.writeFirstSyncMergeArchive.and.rejectWith(new Error('idb'));
      await expectAsync(service.run(provider, USER_ID)).toBeRejected();
      expect(calls).not.toContain('dispatch');
      expect(calls).not.toContain('clearPending');
      expect(pendingInDb).not.toBeNull();
      expect(isDone()).toBeFalse();
    });

    it('ops not persisted: rejects and keeps the marker', async () => {
      persistOps = false;
      await expectAsync(service.run(provider, USER_ID)).toBeRejected();
      expect(calls).not.toContain('clearPending');
      expect(isDone()).toBeFalse();
    });

    it('download failure: rejects, marker kept with downloaded=false', async () => {
      opLogSync.forceDownloadRemoteState.and.rejectWith(new Error('network'));
      await expectAsync(service.run(provider, USER_ID)).toBeRejected();
      expect((pendingInDb as FirstSyncMergePending).downloaded).toBeFalse();
      expect(calls).not.toContain('dispatch');
    });
  });

  describe('resume', () => {
    const localOp = (
      seq: number,
      entityType: string,
      entityId: string,
    ): OperationLogEntry =>
      ({ seq, source: 'local', op: { entityType, entityId } }) as OperationLogEntry;
    const remoteOp = (
      seq: number,
      entityType: string,
      entityId: string,
    ): OperationLogEntry =>
      ({ seq, source: 'remote', op: { entityType, entityId } }) as OperationLogEntry;

    it('new app session with downloaded=true: always downloads again', async () => {
      pendingInDb = pendingRecord({ downloaded: true });
      // after a restart the store is the old local cache + replayed remote ops
      storeState = data([project('pLocal')], [task('t1', { projectId: 'pLocal' })]);
      expect(await service.runIfNeeded(provider)).toBe('MERGED');
      expect(calls).toContain('deleteRemoteOps');
      expect(calls).toContain('resetStore');
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalledTimes(1);
      // own items are compared against the downloaded remote, so they are uploaded
      expect(allDispatched().projects.map((p) => p.id)).toEqual(['pLocal']);
      expect(allDispatched().tasks.map((t) => t.id)).toEqual(['t1']);
      expect(pendingInDb).toBeNull();
      expect(isDone()).toBeTrue();
    });

    it('same session after the download (e.g. archive write failed): no second download', async () => {
      archiveHandler.writeFirstSyncMergeArchive.and.rejectWith(new Error('idb'));
      await expectAsync(service.runIfNeeded(provider)).toBeRejected();
      archiveHandler.writeFirstSyncMergeArchive.and.resolveTo();
      expect(await service.runIfNeeded(provider)).toBe('MERGED');
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalledTimes(1);
      expect(allDispatched().projects.map((p) => p.id)).toEqual(['pLocal']);
    });

    it('folds only entities of local ops since the marker, never remote-replayed ones', async () => {
      pendingInDb = pendingRecord({
        downloaded: false,
        local: data([project('pLocal')], [task('t1', { projectId: 'pLocal' })]),
      });
      // store: t1 replaced by a replayed remote copy (newer), tNew created by the user,
      // tRemote only from replayed remote ops
      storeState = data(
        [project('pLocal')],
        [
          task('t1', { projectId: 'pLocal', title: 'replayed', modified: 99 }),
          task('tNew', { projectId: 'pLocal' }),
          task('tRemote', { projectId: 'pLocal' }),
        ],
      );
      opsAfterSeq = [
        localOp(51, 'TASK', 'tNew'),
        localOp(40, 'TASK', 'tRemote'), // before the marker
        remoteOp(52, 'TASK', 't1'),
      ];
      await service.runIfNeeded(provider);
      expect(calls.slice(0, 3)).toEqual([
        'deleteRemoteOps',
        'savePending:false',
        'archiveReset',
      ]);
      const tasks = allDispatched().tasks;
      expect(tasks.map((t) => t.id).sort()).toEqual(['t1', 'tNew']);
      expect(tasks.find((t) => t.id === 't1')!.title).toBe('t1');
      expect(pendingInDb).toBeNull();
      // only remote ops written after the merge started are removed
      const entry = (source: 'local' | 'remote', seq: number): OperationLogEntry =>
        ({ source, seq }) as OperationLogEntry;
      expect(deletePredicate!(entry('remote', 51))).toBeTrue();
      expect(deletePredicate!(entry('remote', 50))).toBeFalse();
      expect(deletePredicate!(entry('local', 99))).toBeFalse();
    });

    it('download failure restores the local snapshot and keeps the marker', async () => {
      const local = pendingRecord({ downloaded: false }).local;
      pendingInDb = pendingRecord({ downloaded: false, local });
      opLogSync.forceDownloadRemoteState.and.rejectWith(new Error('network'));
      await expectAsync(service.runIfNeeded(provider)).toBeRejected();
      const loads = (
        TestBed.inject(Store) as unknown as jasmine.SpyObj<Store>
      ).dispatch.calls
        .allArgs()
        .map(([a]) => a as unknown as ReturnType<typeof loadAllData>)
        .filter((a) => a.type === loadAllData.type);
      const restored = loads[loads.length - 1].appDataComplete as AppDataComplete;
      expect(restored.project.ids).toEqual(['pLocal']);
      expect(restored.globalConfig).toBeUndefined();
      expect(archiveDb.saveArchivesAtomic).toHaveBeenCalledWith(
        local.archiveYoung,
        local.archiveOld,
      );
      expect(pendingInDb).not.toBeNull();
      expect(service.isFirstSyncMergePendingOrRequired()).toBeTrue();
    });

    it('different account in session: rejects, marker kept, nothing touched', async () => {
      pendingInDb = pendingRecord({ userId: 7 });
      await expectAsync(service.runIfNeeded(provider)).toBeRejected();
      expect(calls).toEqual([]);
      expect(pendingInDb).not.toBeNull();
      expect(service.isFirstSyncMergePendingOrRequired()).toBeTrue();
    });

    it('corrupt snapshot: rejects and clears nothing', async () => {
      pendingInDb = { userId: USER_ID, downloaded: true };
      await expectAsync(service.runIfNeeded(provider)).toBeRejected();
      expect(calls).toEqual([]);
      expect(pendingInDb).not.toBeNull();
    });
  });

  describe('planFirstSyncResume', () => {
    it('re-downloads and folds local edits unless downloaded in this session', () => {
      expect(planFirstSyncResume(false)).toEqual({
        redownload: true,
        foldLocalEdits: true,
      });
      expect(planFirstSyncResume(true)).toEqual({
        redownload: false,
        foldLocalEdits: false,
      });
    });
  });
});
