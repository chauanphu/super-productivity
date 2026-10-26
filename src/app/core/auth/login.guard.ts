import { inject, Injectable } from '@angular/core';
import { Router, UrlTree } from '@angular/router';
import { SuperSyncAuthService } from '../../op-log/sync-providers/super-sync/super-sync-auth.service';
import { environment } from '../../../environments/environment';

// Single switch for the mandatory login gate (build-time; false only in the e2e build).
export const IS_LOGIN_REQUIRED: boolean = environment.isLoginRequired;

@Injectable({ providedIn: 'root' })
export class LoginGuard {
  private _auth = inject(SuperSyncAuthService);
  private _router = inject(Router);

  // Only reads the cached token (no network, no data-init wait), so it works offline.
  async canActivate(): Promise<boolean | UrlTree> {
    if (!IS_LOGIN_REQUIRED) {
      return true;
    }
    return (await this._auth.getSession()) ? true : this._router.parseUrl('/login');
  }
}

export const isLoginUrl = (url: string): boolean => /^\/login(?:[?#]|$)/.test(url);
