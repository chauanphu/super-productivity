import { TestBed } from '@angular/core/testing';
import {
  InvalidCredentialsError,
  LoginNetworkError,
  LoginServerError,
  SuperSyncAuthService,
} from './super-sync-auth.service';
import { SyncProviderManager } from '../provider-manager.service';
import { GlobalConfigService } from '../../../features/config/global-config.service';
import { SyncProviderId } from '../provider.const';

const b64url = (o: object): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

describe('SuperSyncAuthService', () => {
  let service: SuperSyncAuthService;
  let manager: jasmine.SpyObj<SyncProviderManager>;
  let cfg: jasmine.SpyObj<GlobalConfigService>;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    manager = jasmine.createSpyObj('SyncProviderManager', [
      'getProviderConfig',
      'setProviderConfig',
    ]);
    cfg = jasmine.createSpyObj('GlobalConfigService', ['updateSection']);
    TestBed.configureTestingModule({
      providers: [
        { provide: SyncProviderManager, useValue: manager },
        { provide: GlobalConfigService, useValue: cfg },
      ],
    });
    service = TestBed.inject(SuperSyncAuthService);
    fetchSpy = spyOn(window, 'fetch');
  });

  it('login posts normalized credentials and returns the session without saving', async () => {
    fetchSpy.and.resolveTo(
      new Response(JSON.stringify({ token: 't', user: { id: 7, email: 'a@b.c' } }), {
        status: 200,
      }),
    );
    const s = await service.login('https://x.io/', '  A@B.C ', 'pw');
    expect(fetchSpy.calls.mostRecent().args[0]).toBe('https://x.io/api/login/password');
    expect(JSON.parse(fetchSpy.calls.mostRecent().args[1].body)).toEqual({
      email: 'a@b.c',
      password: 'pw',
    });
    expect(s).toEqual({ token: 't', userId: 7, email: 'a@b.c', baseUrl: 'https://x.io' });
    expect(manager.setProviderConfig).not.toHaveBeenCalled();
  });

  it('login throws InvalidCredentialsError on 401', async () => {
    fetchSpy.and.resolveTo(new Response('{}', { status: 401 }));
    await expectAsync(service.login('https://x.io', 'a@b.c', 'pw')).toBeRejectedWithError(
      InvalidCredentialsError,
    );
  });

  it('login throws LoginNetworkError when fetch rejects', async () => {
    fetchSpy.and.rejectWith(new TypeError('offline'));
    await expectAsync(service.login('https://x.io', 'a@b.c', 'pw')).toBeRejectedWithError(
      LoginNetworkError,
    );
  });

  it('login throws LoginServerError with status for 429 and 500', async () => {
    for (const status of [429, 500]) {
      fetchSpy.and.resolveTo(new Response('{}', { status }));
      const err = await service.login('https://x.io', 'a@b.c', 'pw').catch((e) => e);
      expect(err).toBeInstanceOf(LoginServerError);
      expect((err as LoginServerError).status).toBe(status);
    }
  });

  it('login throws LoginServerError for malformed 200 bodies', async () => {
    for (const body of ['not json', '{}', '{"token":"t","user":{"id":1}}']) {
      fetchSpy.and.resolveTo(new Response(body, { status: 200 }));
      await expectAsync(
        service.login('https://x.io', 'a@b.c', 'pw'),
      ).toBeRejectedWithError(LoginServerError);
    }
  });

  it('commitSession does not carry over stale refreshToken/expiresAt', async () => {
    manager.getProviderConfig.and.resolveTo({
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: 1,
    });
    await service.commitSession({ token: 'n', userId: 1, email: 'a@b.c', baseUrl: 'u' });
    const saved = manager.setProviderConfig.calls.mostRecent().args[1] as {
      refreshToken?: string;
      expiresAt?: number;
    };
    expect(saved.refreshToken).toBeUndefined();
    expect(saved.expiresAt).toBeUndefined();
  });

  it('commitSession merges private cfg and enables SuperSync', async () => {
    manager.getProviderConfig.and.resolveTo({
      accessToken: 'old',
      isEncryptionEnabled: true,
    });
    await service.commitSession({
      token: 'new',
      userId: 1,
      email: 'a@b.c',
      baseUrl: 'https://x.io',
    });
    expect(manager.setProviderConfig).toHaveBeenCalledWith(SyncProviderId.SuperSync, {
      accessToken: 'new',
      isEncryptionEnabled: true,
      baseUrl: 'https://x.io',
      refreshToken: undefined,
      expiresAt: undefined,
    });
    expect(cfg.updateSection).toHaveBeenCalledWith('sync', {
      isEnabled: true,
      syncProvider: SyncProviderId.SuperSync,
    });
  });

  it('getSession decodes the JWT payload', async () => {
    const token = `h.${b64url({ userId: 5, email: 'é@b.c' })}.s`;
    manager.getProviderConfig.and.resolveTo({ accessToken: token });
    expect(await service.getSession()).toEqual({ userId: 5, email: 'é@b.c' });
  });

  it('getSession returns null for garbage or missing token', async () => {
    manager.getProviderConfig.and.resolveTo({ accessToken: 'garbage' });
    expect(await service.getSession()).toBeNull();
    manager.getProviderConfig.and.resolveTo(null);
    expect(await service.getSession()).toBeNull();
  });
});
