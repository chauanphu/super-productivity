import { DEFAULT_GLOBAL_CONFIG } from './default-global-config.const';

describe('DEFAULT_GLOBAL_CONFIG', () => {
  it('should not default SuperSync to any server (self-hosted only)', () => {
    expect(DEFAULT_GLOBAL_CONFIG.sync.superSync?.baseUrl).toBe('');
  });
});
