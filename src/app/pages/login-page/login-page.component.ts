import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButton } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../t.const';
import { isOnline } from '../../util/is-online';
import {
  InvalidCredentialsError,
  LoginNetworkError,
  SuperSyncAuthService,
} from '../../op-log/sync-providers/super-sync/super-sync-auth.service';
import { AccountSessionService } from '../../core/auth/account-session.service';

@Component({
  selector: 'login-page',
  templateUrl: './login-page.component.html',
  styleUrls: ['./login-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButton, TranslatePipe],
})
export class LoginPageComponent implements OnInit {
  private _auth = inject(SuperSyncAuthService);
  private _accountSession = inject(AccountSessionService);
  private _router = inject(Router);

  readonly T = T;
  // Empty on purpose: credentials must never go to a server the user did not type.
  baseUrl = '';
  email = '';
  password = '';
  readonly isSubmitting = signal(false);
  readonly errorKey = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    // e.g. after an account-switch wipe reloaded onto /login with the new session committed
    if (await this._auth.getSession()) {
      await this._router.navigateByUrl('/', { replaceUrl: true });
    }
  }

  urlErrorKey(): string | null {
    const url = this.baseUrl.trim();
    if (!url) {
      return T.F.SYNC.LOGIN.ERR_URL_REQUIRED;
    }
    try {
      return /^https?:$/.test(new URL(url).protocol)
        ? null
        : T.F.SYNC.LOGIN.ERR_URL_INVALID;
    } catch {
      return T.F.SYNC.LOGIN.ERR_URL_INVALID;
    }
  }

  async submit(): Promise<void> {
    if (this.isSubmitting()) {
      return;
    }
    this.errorKey.set(this.urlErrorKey());
    if (this.errorKey()) {
      return;
    }
    if (!isOnline()) {
      this.errorKey.set(T.F.SYNC.LOGIN.ERR_OFFLINE);
      return;
    }
    this.isSubmitting.set(true);
    try {
      const session = await this._auth.login(
        this.baseUrl.trim().replace(/\/+$/, ''),
        this.email,
        this.password,
      );
      if ((await this._accountSession.completeLogin(session)) === 'DONE') {
        await this._router.navigateByUrl('/');
      }
    } catch (e) {
      this.errorKey.set(
        e instanceof InvalidCredentialsError
          ? T.F.SYNC.LOGIN.ERR_INVALID_CREDENTIALS
          : e instanceof LoginNetworkError
            ? T.F.SYNC.LOGIN.ERR_OFFLINE
            : T.F.SYNC.LOGIN.ERR_SERVER, // LoginServerError and anything unexpected
      );
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
