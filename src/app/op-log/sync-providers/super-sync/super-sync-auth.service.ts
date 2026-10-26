import { inject, Injectable } from '@angular/core';
import { SyncProviderManager } from '../provider-manager.service';
import { GlobalConfigService } from '../../../features/config/global-config.service';
import { SyncProviderId } from '../provider.const';

export type AuthSession = {
  token: string;
  userId: number;
  email: string;
  baseUrl: string;
};

export class InvalidCredentialsError extends Error {
  override name = 'InvalidCredentialsError';
}

export class LoginNetworkError extends Error {
  override name = 'LoginNetworkError';
}

export class LoginServerError extends Error {
  override name = 'LoginServerError';
  constructor(readonly status: number) {
    super(`Login failed with status ${status}`);
  }
}

@Injectable({ providedIn: 'root' })
export class SuperSyncAuthService {
  private _manager = inject(SyncProviderManager);
  private _globalConfig = inject(GlobalConfigService);

  async login(baseUrl: string, email: string, password: string): Promise<AuthSession> {
    const base = baseUrl.replace(/\/+$/, '');
    const normalizedEmail = email.trim().toLowerCase();
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await fetch(`${base}/api/login/password`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: normalizedEmail, password }),
      });
    } catch {
      throw new LoginNetworkError('Login request failed');
    }
    if (res.status === 401) {
      throw new InvalidCredentialsError('Invalid credentials');
    }
    if (!res.ok) {
      throw new LoginServerError(res.status);
    }
    let body: { token?: string; user?: { id?: number; email?: string } };
    try {
      body = await res.json();
    } catch {
      throw new LoginServerError(res.status);
    }
    const { token, user } = body ?? {};
    if (!token || typeof user?.id !== 'number' || !user.email) {
      throw new LoginServerError(res.status);
    }
    return { token, userId: user.id, email: user.email, baseUrl: base };
  }

  async commitSession(s: AuthSession): Promise<void> {
    // Merge so encryption settings survive; Task 8 handles cross-account switching.
    const existing = await this._manager.getProviderConfig(SyncProviderId.SuperSync);
    await this._manager.setProviderConfig(SyncProviderId.SuperSync, {
      ...existing,
      baseUrl: s.baseUrl,
      accessToken: s.token,
      refreshToken: undefined,
      expiresAt: undefined,
    });
    this._globalConfig.updateSection('sync', {
      isEnabled: true,
      syncProvider: SyncProviderId.SuperSync,
    });
  }

  async getSession(): Promise<{ userId: number; email: string } | null> {
    const cfg = await this._manager.getProviderConfig(SyncProviderId.SuperSync);
    const payload = cfg?.accessToken?.split('.')[1];
    if (!payload) {
      return null;
    }
    try {
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const { userId, email } = JSON.parse(new TextDecoder().decode(bytes));
      return typeof userId === 'number' && typeof email === 'string'
        ? { userId, email }
        : null;
    } catch {
      return null;
    }
  }
}
