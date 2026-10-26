import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { LoginPageComponent } from './login-page.component';
import {
  InvalidCredentialsError,
  LoginNetworkError,
  LoginServerError,
  SuperSyncAuthService,
} from '../../op-log/sync-providers/super-sync/super-sync-auth.service';
import { SUPER_SYNC_DEFAULT_BASE_URL } from '../../op-log/sync-providers/super-sync/super-sync.model';
import { T } from '../../t.const';
import { AccountSessionService } from '../../core/auth/account-session.service';

describe('LoginPageComponent', () => {
  let login: jasmine.Spy;
  let completeLogin: jasmine.Spy;
  let cmp: LoginPageComponent;

  beforeEach(() => {
    login = jasmine.createSpy('login');
    completeLogin = jasmine.createSpy('completeLogin').and.resolveTo('DONE');
    TestBed.configureTestingModule({
      imports: [LoginPageComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]),
        { provide: SuperSyncAuthService, useValue: { login } },
        { provide: AccountSessionService, useValue: { completeLogin } },
      ],
    });
    spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    cmp = TestBed.createComponent(LoginPageComponent).componentInstance;
    cmp.email = 'a@b.c';
    cmp.password = 'pw';
  });

  it('defaults the server URL', () => {
    expect(cmp.baseUrl).toBe(SUPER_SYNC_DEFAULT_BASE_URL);
  });

  it('logs in with form values, completes the login and navigates home', async () => {
    const session = { token: 't', userId: 1, email: 'a@b.c', baseUrl: 'x' };
    login.and.resolveTo(session);
    await cmp.submit();
    expect(login).toHaveBeenCalledWith(SUPER_SYNC_DEFAULT_BASE_URL, 'a@b.c', 'pw');
    expect(completeLogin).toHaveBeenCalledWith(session);
    expect(TestBed.inject(Router).navigateByUrl).toHaveBeenCalledWith('/');
    expect(cmp.errorKey()).toBeNull();
    expect(cmp.isSubmitting()).toBe(false);
  });

  it('stays on the page when the account switch is cancelled', async () => {
    login.and.resolveTo({ token: 't', userId: 1, email: 'a@b.c', baseUrl: 'x' });
    completeLogin.and.resolveTo('CANCELLED');
    await cmp.submit();
    expect(TestBed.inject(Router).navigateByUrl).not.toHaveBeenCalled();
    expect(cmp.errorKey()).toBeNull();
  });

  it('shows offline message without calling login', async () => {
    spyOnProperty(navigator, 'onLine').and.returnValue(false);
    await cmp.submit();
    expect(login).not.toHaveBeenCalled();
    expect(cmp.errorKey()).toBe(T.F.SYNC.LOGIN.ERR_OFFLINE);
  });

  it('maps InvalidCredentialsError', async () => {
    login.and.rejectWith(new InvalidCredentialsError('x'));
    await cmp.submit();
    expect(cmp.errorKey()).toBe(T.F.SYNC.LOGIN.ERR_INVALID_CREDENTIALS);
    expect(completeLogin).not.toHaveBeenCalled();
  });

  it('maps LoginNetworkError', async () => {
    login.and.rejectWith(new LoginNetworkError('x'));
    await cmp.submit();
    expect(cmp.errorKey()).toBe(T.F.SYNC.LOGIN.ERR_OFFLINE);
  });

  it('maps LoginServerError', async () => {
    login.and.rejectWith(new LoginServerError(429));
    await cmp.submit();
    expect(cmp.errorKey()).toBe(T.F.SYNC.LOGIN.ERR_SERVER);
    expect(cmp.isSubmitting()).toBe(false);
  });
});
