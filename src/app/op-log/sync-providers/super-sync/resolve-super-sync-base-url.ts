import { InjectionToken } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { IS_NATIVE_PLATFORM } from '../../../util/is-native-platform';
import { IS_ELECTRON } from '../../../app.constants';

const IS_HTTP = /^https?:$/;

/**
 * The SuperSync server the app talks to: the build's `superSyncBaseUrl`, else the
 * origin serving the app (web only). Null means no server is configured; there is
 * deliberately no hard-coded external fallback.
 */
export const resolveSuperSyncBaseUrl = (
  envValue: string | undefined,
  location: Pick<Location, 'protocol' | 'origin'>,
  isNativeApp = false,
): string | null => {
  const configured = envValue?.trim();
  if (configured) {
    try {
      return IS_HTTP.test(new URL(configured).protocol)
        ? configured.replace(/\/+$/, '')
        : null;
    } catch {
      return null;
    }
  }
  // Electron (file:// or a dev server) and Capacitor (https://localhost) origins are not sync servers.
  return !isNativeApp && IS_HTTP.test(location.protocol) ? location.origin : null;
};

export const SUPER_SYNC_BASE_URL = new InjectionToken<string | null>(
  'SUPER_SYNC_BASE_URL',
  {
    providedIn: 'root',
    factory: () =>
      resolveSuperSyncBaseUrl(
        environment.superSyncBaseUrl,
        window.location,
        IS_NATIVE_PLATFORM || IS_ELECTRON,
      ),
  },
);
