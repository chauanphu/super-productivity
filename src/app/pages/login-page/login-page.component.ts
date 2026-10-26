import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButton } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../t.const';
import { isOnline } from '../../util/is-online';
import { SUPER_SYNC_DEFAULT_BASE_URL } from '../../op-log/sync-providers/super-sync/super-sync.model';
import {
  InvalidCredentialsError,
  LoginNetworkError,
  SuperSyncAuthService,
} from '../../op-log/sync-providers/super-sync/super-sync-auth.service';

@Component({
  selector: 'login-page',
  templateUrl: './login-page.component.html',
  styleUrls: ['./login-page.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButton, TranslatePipe],
})
export class LoginPageComponent {
  private _auth = inject(SuperSyncAuthService);
  private _router = inject(Router);

  readonly T = T;
  baseUrl = SUPER_SYNC_DEFAULT_BASE_URL;
  email = '';
  password = '';
  readonly isSubmitting = signal(false);
  readonly errorKey = signal<string | null>(null);

  async submit(): Promise<void> {
    if (this.isSubmitting()) {
      return;
    }
    this.errorKey.set(null);
    if (!isOnline()) {
      this.errorKey.set(T.F.SYNC.LOGIN.ERR_OFFLINE);
      return;
    }
    this.isSubmitting.set(true);
    try {
      const session = await this._auth.login(this.baseUrl, this.email, this.password);
      // Task 8 replaces this with AccountSessionService.completeLogin(session).
      await this._auth.commitSession(session);
      await this._router.navigateByUrl('/');
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
