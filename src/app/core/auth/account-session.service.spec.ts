import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { BehaviorSubject, of } from 'rxjs';
import { AccountSessionService } from './account-session.service';
import {
  AuthSession,
  SuperSyncAuthService,
} from '../../op-log/sync-providers/super-sync/super-sync-auth.service';
import { LocalDataWipeService } from '../../op-log/persistence/local-data-wipe.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { OperationLogStoreService } from '../../op-log/persistence/operation-log-store.service';
import { OperationWriteFlushService } from '../../op-log/sync/operation-write-flush.service';
import { BackupService } from '../../op-log/backup/backup.service';
import { SyncProviderId, SyncStatus } from '../../op-log/sync-providers/provider.const';
import { SyncProviderManager } from '../../op-log/sync-providers/provider-manager.service';
import { ActionType } from '../../op-log/core/action-types.enum';

describe('AccountSessionService', () => {
  let service: AccountSessionService;
  let auth: jasmine.SpyObj<SuperSyncAuthService>;
  let wipe: jasmine.SpyObj<LocalDataWipeService>;
  let syncWrapper: jasmine.SpyObj<SyncWrapperService> & {
    isEnabledAndReady$: BehaviorSubject<boolean>;
  };
  let store: jasmine.SpyObj<OperationLogStoreService>;
  let dialog: jasmine.SpyObj<MatDialog>;
  let manager: jasmine.SpyObj<SyncProviderManager>;
  let online: jasmine.Spy;
  const calls: string[] = [];
  const next: AuthSession = { token: 't2', userId: 2, email: 'b@c.d', baseUrl: 'u' };

  const unsynced = (n: number): void => {
    store.getUnsynced.and.resolveTo(new Array(n).fill({}) as never);
  };
  const dialogAnswers = (...answers: (boolean | string)[]): void => {
    dialog.open.and.callFake(() => ({ afterClosed: () => of(answers.shift()) }) as never);
  };

  beforeEach(() => {
    calls.length = 0;
    auth = jasmine.createSpyObj('SuperSyncAuthService', ['getSession', 'commitSession']);
    auth.getSession.and.resolveTo({ userId: 1, email: 'a@b.c' });
    auth.commitSession.and.callFake(async () => {
      calls.push('commit');
    });
    wipe = jasmine.createSpyObj('LocalDataWipeService', ['wipeAll']);
    wipe.wipeAll.and.callFake(async () => {
      calls.push('wipe');
    });
    syncWrapper = Object.assign(jasmine.createSpyObj('SyncWrapperService', ['sync']), {
      isEnabledAndReady$: new BehaviorSubject(true),
    });
    syncWrapper.sync.and.callFake(async () => {
      calls.push('sync');
      return SyncStatus.InSync;
    });
    store = jasmine.createSpyObj('OperationLogStoreService', [
      'getUnsynced',
      'loadFirstSyncMergePending',
      'hasSyncedOps',
      'hasRejectedOpOfType',
    ]);
    store.hasSyncedOps.and.resolveTo(false);
    store.hasRejectedOpOfType.and.resolveTo(false);
    manager = jasmine.createSpyObj('SyncProviderManager', [
      'getProviderConfig',
      'getLastSyncedProviderId',
    ]);
    manager.getProviderConfig.and.resolveTo(null);
    manager.getLastSyncedProviderId.and.returnValue(null);
    store.loadFirstSyncMergePending.and.resolveTo(null);
    unsynced(0);
    dialog = jasmine.createSpyObj('MatDialog', ['open']);
    dialogAnswers(false);
    online = spyOnProperty(navigator, 'onLine').and.returnValue(true);

    TestBed.configureTestingModule({
      providers: [
        AccountSessionService,
        { provide: SuperSyncAuthService, useValue: auth },
        { provide: LocalDataWipeService, useValue: wipe },
        { provide: SyncWrapperService, useValue: syncWrapper },
        { provide: OperationLogStoreService, useValue: store },
        {
          provide: OperationWriteFlushService,
          useValue: { flushPendingWrites: () => Promise.resolve() },
        },
        {
          provide: BackupService,
          useValue: { loadCompleteBackup: () => Promise.resolve({}) },
        },
        { provide: MatDialog, useValue: dialog },
        { provide: SyncProviderManager, useValue: manager },
      ],
    });
    service = TestBed.inject(AccountSessionService);
  });

  describe('logout', () => {
    it('online: syncs before wiping', async () => {
      expect(await service.logout()).toBe('DONE');
      expect(calls).toEqual(['sync', 'wipe']);
      expect(dialog.open).not.toHaveBeenCalled();
      expect(wipe.wipeAll).toHaveBeenCalledWith({ nextSession: undefined });
    });

    it('offline with unsynced ops: asks, and cancel does not wipe', async () => {
      online.and.returnValue(false);
      unsynced(3);
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(dialog.open).toHaveBeenCalledTimes(1);
      expect(syncWrapper.sync).not.toHaveBeenCalled();
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('offline with unsynced ops: confirm wipes', async () => {
      online.and.returnValue(false);
      unsynced(3);
      dialogAnswers(true);
      expect(await service.logout()).toBe('DONE');
      expect(wipe.wipeAll).toHaveBeenCalled();
    });

    it('offline without unsynced ops: still asks (server copy unverified), cancel keeps data', async () => {
      online.and.returnValue(false);
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(dialog.open).toHaveBeenCalledTimes(1);
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('offline without unsynced ops: confirm wipes', async () => {
      online.and.returnValue(false);
      dialogAnswers(true);
      expect(await service.logout()).toBe('DONE');
      expect(wipe.wipeAll).toHaveBeenCalled();
    });

    it('sync not InSync without unsynced ops: asks', async () => {
      syncWrapper.sync.and.resolveTo('HANDLED_ERROR');
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(dialog.open).toHaveBeenCalledTimes(1);
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('sync InSync and nothing unsynced: wipes without a dialog', async () => {
      expect(await service.logout()).toBe('DONE');
      expect(dialog.open).not.toHaveBeenCalled();
      expect(wipe.wipeAll).toHaveBeenCalled();
    });

    it('InSync but a first-sync merge op was rejected: asks (merged data may be lost)', async () => {
      store.hasRejectedOpOfType.and.callFake(
        async (t) => t === ActionType.SYNC_APPLY_FIRST_SYNC_MERGE,
      );
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(dialog.open).toHaveBeenCalledTimes(1);
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('sync failure with unsynced ops left: asks', async () => {
      syncWrapper.sync.and.rejectWith(new Error('boom'));
      unsynced(2);
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(dialog.open).toHaveBeenCalledTimes(1);
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('export button downloads a backup and asks again', async () => {
      online.and.returnValue(false);
      unsynced(1);
      const download = spyOn(
        service as unknown as { _download: (d: unknown) => Promise<void> },
        '_download',
      ).and.resolveTo();
      dialogAnswers('EXTRA', true);
      expect(await service.logout()).toBe('DONE');
      expect(download).toHaveBeenCalledTimes(1);
      expect(dialog.open).toHaveBeenCalledTimes(2);
    });

    it('unfinished merge: no sync, explicit confirm, cancel touches nothing', async () => {
      store.loadFirstSyncMergePending.and.resolveTo({ userId: 1, local: {} });
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(syncWrapper.sync).not.toHaveBeenCalled();
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('unfinished merge: confirm wipes with discardPendingMerge and exports the pre-merge snapshot', async () => {
      const local = { task: { ids: ['x'] } };
      store.loadFirstSyncMergePending.and.resolveTo({ userId: 1, local });
      const download = spyOn(
        service as unknown as { _download: (d: unknown) => Promise<void> },
        '_download',
      ).and.resolveTo();
      dialogAnswers('EXTRA', true);
      expect(await service.logout()).toBe('DONE');
      expect(download.calls.mostRecent().args[0]).toEqual(
        jasmine.objectContaining({ data: local }),
      );
      expect(wipe.wipeAll).toHaveBeenCalledWith({
        discardPendingMerge: true,
        nextSession: undefined,
      });
    });

    it('a merge left pending by the pre-wipe sync still needs explicit confirm', async () => {
      store.loadFirstSyncMergePending.and.returnValues(
        Promise.resolve(null),
        Promise.resolve({ userId: 1, local: {} }),
      );
      dialogAnswers(false);
      expect(await service.logout()).toBe('CANCELLED');
      expect(syncWrapper.sync).toHaveBeenCalled();
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });
  });

  describe('completeLogin', () => {
    it('same userId: commits, syncs, never wipes', async () => {
      auth.getSession.and.resolveTo({ userId: 2, email: 'b@c.d' });
      expect(await service.completeLogin(next)).toBe('DONE');
      await new Promise((r) => setTimeout(r));
      expect(auth.commitSession).toHaveBeenCalledWith(next);
      expect(wipe.wipeAll).not.toHaveBeenCalled();
      expect(calls).toEqual(['commit', 'sync']);
    });

    it('no session: commits and syncs', async () => {
      auth.getSession.and.resolveTo(null);
      expect(await service.completeLogin(next)).toBe('DONE');
      await new Promise((r) => setTimeout(r));
      expect(calls).toEqual(['commit', 'sync']);
      expect(wipe.wipeAll).not.toHaveBeenCalled();
    });

    it('different userId: flushes old account, wipes, hands over the new session', async () => {
      expect(await service.completeLogin(next)).toBe('DONE');
      expect(calls).toEqual(['sync', 'wipe']);
      expect(wipe.wipeAll).toHaveBeenCalledWith({ nextSession: next });
      // committed inside wipeAll, after the wipe and before the reload
      expect(auth.commitSession).not.toHaveBeenCalled();
    });

    it('no session but the device belongs to another account (done key): wipes', async () => {
      auth.getSession.and.resolveTo(null);
      localStorage.setItem('SUP_FIRST_SYNC_MERGE_DONE_1', '1');
      try {
        expect(await service.completeLogin(next)).toBe('DONE');
      } finally {
        localStorage.removeItem('SUP_FIRST_SYNC_MERGE_DONE_1');
      }
      expect(wipe.wipeAll).toHaveBeenCalledWith({ nextSession: next });
      expect(auth.commitSession).not.toHaveBeenCalled();
    });

    it('no session, done key of the same account: keeps data', async () => {
      auth.getSession.and.resolveTo(null);
      localStorage.setItem('SUP_FIRST_SYNC_MERGE_DONE_2', '1');
      try {
        expect(await service.completeLogin(next)).toBe('DONE');
      } finally {
        localStorage.removeItem('SUP_FIRST_SYNC_MERGE_DONE_2');
      }
      expect(wipe.wipeAll).not.toHaveBeenCalled();
      expect(auth.commitSession).toHaveBeenCalledWith(next);
    });

    it('no session but a pending merge of another account: switch path', async () => {
      auth.getSession.and.resolveTo(null);
      store.loadFirstSyncMergePending.and.resolveTo({ userId: 1, local: {} });
      dialogAnswers(false);
      expect(await service.completeLogin(next)).toBe('CANCELLED');
      expect(auth.commitSession).not.toHaveBeenCalled();
    });

    describe('no session and no known previous userId', () => {
      const SEQ_KEY = 'super_sync_last_server_seq_testhash';
      beforeEach(() => {
        auth.getSession.and.resolveTo(null);
        online.and.returnValue(false);
        unsynced(1);
      });
      afterEach(() => {
        localStorage.removeItem(SEQ_KEY);
        localStorage.removeItem('SUP_FIRST_SYNC_MERGE_DONE_1');
        localStorage.removeItem('SUP_FIRST_SYNC_MERGE_DONE_3');
      });

      const expectSwitchPath = async (): Promise<void> => {
        dialogAnswers(true);
        expect(await service.completeLogin(next)).toBe('DONE');
        expect(dialog.open).toHaveBeenCalledTimes(1);
        expect(wipe.wipeAll).toHaveBeenCalledWith({ nextSession: next });
        expect(auth.commitSession).not.toHaveBeenCalled();
      };

      it('seq key > 0 means an unknown previous account: confirm + wipe', async () => {
        localStorage.setItem(SEQ_KEY, '42');
        await expectSwitchPath();
      });

      it('unknown account with nothing unsynced still asks; cancel keeps data', async () => {
        localStorage.setItem(SEQ_KEY, '42');
        online.and.returnValue(true);
        unsynced(0);
        dialogAnswers(false);
        expect(await service.completeLogin(next)).toBe('CANCELLED');
        expect(dialog.open).toHaveBeenCalledTimes(1);
        expect(wipe.wipeAll).not.toHaveBeenCalled();
        expect(auth.commitSession).not.toHaveBeenCalled();
      });

      it('a seq key of 0 is no evidence: keeps data', async () => {
        localStorage.setItem(SEQ_KEY, '0');
        expect(await service.completeLogin(next)).toBe('DONE');
        expect(wipe.wipeAll).not.toHaveBeenCalled();
        expect(auth.commitSession).toHaveBeenCalledWith(next);
      });

      it('SuperSync synced ops mean an unknown previous account', async () => {
        manager.getLastSyncedProviderId.and.returnValue(SyncProviderId.SuperSync);
        store.hasSyncedOps.and.resolveTo(true);
        await expectSwitchPath();
      });

      it('a stored SuperSync encryption key means an unknown previous account', async () => {
        manager.getProviderConfig.and.resolveTo({ encryptKey: 'k' } as never);
        await expectSwitchPath();
      });

      it('done keys of two different accounts are unknown, not "the first one"', async () => {
        localStorage.setItem('SUP_FIRST_SYNC_MERGE_DONE_1', '1');
        localStorage.setItem('SUP_FIRST_SYNC_MERGE_DONE_3', '1');
        await expectSwitchPath();
      });
    });

    describe('identity includes the server', () => {
      beforeEach(() => auth.getSession.and.resolveTo({ userId: 2, email: 'b@c.d' }));

      it('same userId on another baseUrl is an account change', async () => {
        manager.getProviderConfig.and.resolveTo({
          baseUrl: 'https://other.example',
          accessToken: 'x',
        } as never);
        expect(await service.completeLogin(next)).toBe('DONE');
        expect(wipe.wipeAll).toHaveBeenCalledWith({ nextSession: next });
      });

      it('same userId and same baseUrl (trailing slash ignored) keeps data', async () => {
        manager.getProviderConfig.and.resolveTo({
          baseUrl: 'https://same.example/',
          accessToken: 'x',
        } as never);
        expect(
          await service.completeLogin({ ...next, baseUrl: 'https://same.example' }),
        ).toBe('DONE');
        expect(wipe.wipeAll).not.toHaveBeenCalled();
        expect(auth.commitSession).toHaveBeenCalled();
      });
    });

    it('different userId + cancel: keeps data and does not commit', async () => {
      online.and.returnValue(false);
      unsynced(1);
      dialogAnswers(false);
      expect(await service.completeLogin(next)).toBe('CANCELLED');
      expect(wipe.wipeAll).not.toHaveBeenCalled();
      expect(auth.commitSession).not.toHaveBeenCalled();
    });
  });
});
