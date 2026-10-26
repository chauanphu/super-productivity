import { SyncProviderPrivateCfgBase } from '../../core/types/sync.types';

export interface SuperSyncPrivateCfg extends SyncProviderPrivateCfgBase {
  /** Base URL of the SuperSync server. Required: there is no default server. */
  baseUrl?: string;
  /** JWT access token for authentication */
  accessToken: string;
  /** Optional refresh token for token renewal */
  refreshToken?: string;
  /** Token expiration timestamp (Unix ms) */
  expiresAt?: number;
  /** Whether E2E encryption is enabled for operation payloads */
  isEncryptionEnabled?: boolean;
  // Note: encryptKey is inherited from SyncProviderPrivateCfgBase
}
