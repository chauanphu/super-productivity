import { TestBed } from '@angular/core/testing';
import { LocalDataWipeService } from './local-data-wipe.service';
import { OperationLogStoreService } from './operation-log-store.service';
import { LegacyPfDbService } from '../../core/persistence/legacy-pf-db.service';
import { SyncProviderManager } from '../sync-providers/provider-manager.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { OperationWriteFlushService } from '../sync/operation-write-flush.service';
import { LockService } from '../sync/lock.service';
import { SuperSyncAuthService } from '../sync-providers/super-sync/super-sync-auth.service';
import { SyncProviderId } from '../sync-providers/provider.const';

describe('LocalDataWipeService', () => {
  let service: LocalDataWipeService;
  let store: jasmine.SpyObj<OperationLogStoreService>;
  let legacy: jasmine.SpyObj<LegacyPfDbService>;
  let manager: jasmine.SpyObj<SyncProviderManager>;
  let syncWrapper: jasmine.SpyObj<SyncWrapperService>;
  let flush: jasmine.SpyObj<OperationWriteFlushService>;
  let auth: jasmine.SpyObj<SuperSyncAuthService>;
  let privateCfgClear: jasmine.Spy;
  let reload: jasmine.Spy;
  const calls: string[] = [];

  const WIPED_KEYS = [
    'super_sync_last_server_seq_abc',
    'super_sync_last_server_seq_def',
    'SUP_FIRST_SYNC_MERGE_DONE_7',
    'SP_LAST_SYNCED_PROVIDER_ID',
    'sp_profile_meta',
    'sp_profile_data_p1',
  ];
  const KEPT_KEY = 'SP_UNRELATED_TEST_KEY';

  beforeEach(() => {
    calls.length = 0;
    const track = (name: string) => (): Promise<void> => {
      calls.push(name);
      return Promise.resolve();
    };
    store = jasmine.createSpyObj('OperationLogStoreService', [
      'loadFirstSyncMergePending',
      'clearAllUserData',
    ]);
    store.loadFirstSyncMergePending.and.resolveTo(null);
    store.clearAllUserData.and.callFake(track('clearAllUserData'));
    legacy = jasmine.createSpyObj('LegacyPfDbService', [
      'databaseExists',
      'clearAll',
      'hasUsableEntityData',
    ]);
    legacy.databaseExists.and.resolveTo(true);
    legacy.clearAll.and.callFake(track('legacyClearAll'));
    legacy.hasUsableEntityData.and.resolveTo(false);
    privateCfgClear = jasmine.createSpy('clear').and.callFake(track('privateCfgClear'));
    manager = jasmine.createSpyObj('SyncProviderManager', ['getProviderById']);
    manager.getProviderById.and.resolveTo({
      privateCfg: { clear: privateCfgClear },
    } as never);
    syncWrapper = jasmine.createSpyObj('SyncWrapperService', [
      'disconnectWebSocket',
      'runWithSyncBlocked',
    ]);
    syncWrapper.runWithSyncBlocked.and.callFake(<T>(op: () => Promise<T>) => {
      calls.push('blocked');
      return op();
    });
    flush = jasmine.createSpyObj('OperationWriteFlushService', ['flushPendingWrites']);
    flush.flushPendingWrites.and.callFake(track('flush'));
    auth = jasmine.createSpyObj('SuperSyncAuthService', ['commitSession']);
    auth.commitSession.and.callFake(track('commitSession'));

    TestBed.configureTestingModule({
      providers: [
        LocalDataWipeService,
        { provide: OperationLogStoreService, useValue: store },
        { provide: LegacyPfDbService, useValue: legacy },
        { provide: SyncProviderManager, useValue: manager },
        { provide: SyncWrapperService, useValue: syncWrapper },
        { provide: OperationWriteFlushService, useValue: flush },
        {
          provide: LockService,
          useValue: { request: (_n: string, fn: () => Promise<void>) => fn() },
        },
        { provide: SuperSyncAuthService, useValue: auth },
      ],
    });
    service = TestBed.inject(LocalDataWipeService);
    reload = spyOn(service as unknown as { _reload: () => void }, '_reload').and.callFake(
      () => {
        calls.push('reload');
      },
    );
    [...WIPED_KEYS, KEPT_KEY].forEach((k) => localStorage.setItem(k, '5'));
  });

  afterEach(() => {
    [...WIPED_KEYS, KEPT_KEY].forEach((k) => localStorage.removeItem(k));
  });

  it('clears every store, credential and marker key, then reloads', async () => {
    await service.wipeAll();

    expect(syncWrapper.disconnectWebSocket).toHaveBeenCalled();
    expect(store.clearAllUserData).toHaveBeenCalled();
    expect(legacy.clearAll).toHaveBeenCalled();
    expect(manager.getProviderById).toHaveBeenCalledWith(SyncProviderId.SuperSync);
    expect(privateCfgClear).toHaveBeenCalled();
    WIPED_KEYS.forEach((k) => expect(localStorage.getItem(k)).withContext(k).toBeNull());
    expect(localStorage.getItem(KEPT_KEY)).toBe('5');
    expect(auth.commitSession).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'blocked',
      'flush',
      'legacyClearAll',
      'clearAllUserData',
      'privateCfgClear',
      'reload',
    ]);
  });

  it('refuses while an unfinished first-sync merge is pending', async () => {
    store.loadFirstSyncMergePending.and.resolveTo({ userId: 1 });
    await expectAsync(service.wipeAll()).toBeRejected();
    expect(store.clearAllUserData).not.toHaveBeenCalled();
    expect(privateCfgClear).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(WIPED_KEYS[0])).toBe('5');
  });

  it('discards a pending merge when explicitly asked', async () => {
    store.loadFirstSyncMergePending.and.resolveTo({ userId: 1 });
    await service.wipeAll({ discardPendingMerge: true });
    expect(store.clearAllUserData).toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it('commits the next session after the wipe and before the reload', async () => {
    const next = { token: 't', userId: 2, email: 'b@c.d', baseUrl: 'u' };
    await service.wipeAll({ nextSession: next });
    expect(auth.commitSession).toHaveBeenCalledWith(next);
    expect(calls.slice(-4)).toEqual([
      'privateCfgClear',
      'commitSession',
      'flush',
      'reload',
    ]);
  });

  it('does not reload when the legacy database still has data after clearing', async () => {
    legacy.hasUsableEntityData.and.resolveTo(true);
    await expectAsync(service.wipeAll()).toBeRejected();
    expect(store.clearAllUserData).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('skips the legacy database when it does not exist', async () => {
    legacy.databaseExists.and.resolveTo(false);
    await service.wipeAll();
    expect(legacy.clearAll).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });
});
