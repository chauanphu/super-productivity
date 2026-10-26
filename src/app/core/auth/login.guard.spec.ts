import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LoginGuard } from './login.guard';
import { SuperSyncAuthService } from '../../op-log/sync-providers/super-sync/super-sync-auth.service';

describe('LoginGuard', () => {
  let getSession: jasmine.Spy;
  let guard: LoginGuard;
  let originalFetch: typeof window.fetch;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    originalFetch = window.fetch;
    fetchSpy = jasmine.createSpy('fetch');
    window.fetch = fetchSpy as unknown as typeof window.fetch;
    getSession = jasmine.createSpy('getSession');
    TestBed.configureTestingModule({
      providers: [
        { provide: SuperSyncAuthService, useValue: { getSession } },
        {
          provide: Router,
          useValue: { parseUrl: (u: string) => ({ url: u }) as unknown },
        },
      ],
    });
    guard = TestBed.inject(LoginGuard);
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('allows when a session exists', async () => {
    getSession.and.resolveTo({ userId: 1, email: 'a@b.c' });
    expect(await guard.canActivate()).toBe(true);
  });

  it('redirects to /login without a session', async () => {
    getSession.and.resolveTo(null);
    expect(await guard.canActivate()).toEqual({ url: '/login' } as never);
  });

  it('only reads the cached token, so it works offline', async () => {
    getSession.and.resolveTo({ userId: 1, email: 'a@b.c' });
    expect(await guard.canActivate()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // shortcut: IS_LOGIN_REQUIRED is a const, so the "false allows" branch is not unit-testable.
});
