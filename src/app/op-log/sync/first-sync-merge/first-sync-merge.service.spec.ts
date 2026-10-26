import { TestBed } from '@angular/core/testing';
import { Store } from '@ngrx/store';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import {
  FIRST_SYNC_MERGE_DONE_KEY_PREFIX,
  FirstSyncMergePending,
  FirstSyncMergeService,
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

  beforeEach(() => {
    calls = [];
    dispatched = [];
    pendingInDb = null;
    persistOps = true;
    lastServerSeq = 0;
    encryptKey = undefined;
    remoteOps = [{ op: {} }];
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
    ]);
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
      calls.push('dispatch');
      if (persistOps) {
        dispatched.push(a.payload);
      }
    });

    provider = jasmine.createSpyObj('OperationSyncCapable', [
      'getLastServerSeq',
      'downloadOps',
      'getEncryptKey',
    ]);
    provider.getLastServerSeq.and.callFake(async () => lastServerSeq);
    provider.downloadOps.and.callFake(async () => ({ ops: remoteOps }) as never);
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

    it('skips and sets the done marker when the device already has synced ops', async () => {
      opLogStore.hasSyncedOps.and.resolveTo(true);
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
  });

  describe('run', () => {
    it('without conflicts: no dialog, ordered steps, MERGED', async () => {
      expect(await service.run(provider, USER_ID)).toBe('MERGED');
      expect(conflictDialog.open).not.toHaveBeenCalled();
      expect(calls).toEqual([
        'savePending:false',
        'archiveReset',
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

    it('empty remote (new account): pushes all local projects', async () => {
      remoteOps = [];
      opLogSync.forceDownloadRemoteState.and.callFake(async () => {
        calls.push('forceDownload'); // empty server: store keeps local data
      });
      await service.run(provider, USER_ID);
      expect(allDispatched().projects.map((p) => p.id)).toEqual(['pLocal']);
      expect((pendingInDb as FirstSyncMergePending | null) ?? null).toBeNull();
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
      matDialog.open.and.returnValue({
        afterClosed: () => of({ password: 'pw' }),
      } as never);
      expect(await service.run(provider, USER_ID)).toBe('MERGED');
      expect(opLogSync.forceDownloadRemoteState).toHaveBeenCalled();
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
  });

  describe('resume', () => {
    it('after download: merges persisted local onto current store, no re-download', async () => {
      pendingInDb = {
        userId: USER_ID,
        local: data([project('pLocal')], [task('t1', { projectId: 'pLocal' })]),
        downloaded: true,
        remoteEmpty: false,
      } satisfies FirstSyncMergePending;
      storeState = remoteState;
      expect(await service.runIfNeeded(provider)).toBe('MERGED');
      expect(opLogSync.forceDownloadRemoteState).not.toHaveBeenCalled();
      expect(auth.getSession).not.toHaveBeenCalled();
      expect(allDispatched().projects.map((p) => p.id)).toEqual(['pLocal']);
      expect(pendingInDb).toBeNull();
      expect(isDone()).toBeTrue();
    });

    it('before download: re-runs the download first', async () => {
      pendingInDb = {
        userId: USER_ID,
        local: data([project('pLocal')]),
        downloaded: false,
        remoteEmpty: false,
      } satisfies FirstSyncMergePending;
      await service.runIfNeeded(provider);
      expect(calls.slice(0, 3)).toEqual([
        'archiveReset',
        'forceDownload',
        'savePending:true',
      ]);
      expect(allDispatched().projects.map((p) => p.id)).toEqual(['pLocal']);
      expect(pendingInDb).toBeNull();
    });

    it('corrupt snapshot: rejects and clears nothing', async () => {
      pendingInDb = { userId: USER_ID, downloaded: true };
      await expectAsync(service.runIfNeeded(provider)).toBeRejected();
      expect(calls).toEqual([]);
      expect(pendingInDb).not.toBeNull();
    });
  });
});
