import { resolveSuperSyncBaseUrl } from './resolve-super-sync-base-url';

describe('resolveSuperSyncBaseUrl', () => {
  const web = { protocol: 'https:', origin: 'https://app.example' };

  it('prefers the environment value over the page origin', () => {
    expect(resolveSuperSyncBaseUrl('http://localhost:1901', web)).toBe(
      'http://localhost:1901',
    );
  });

  it('strips trailing slashes and whitespace', () => {
    expect(resolveSuperSyncBaseUrl(' https://sync.example/// ', web)).toBe(
      'https://sync.example',
    );
  });

  it('falls back to the origin for http and https pages', () => {
    expect(resolveSuperSyncBaseUrl('', web)).toBe('https://app.example');
    expect(
      resolveSuperSyncBaseUrl(undefined, {
        protocol: 'http:',
        origin: 'http://localhost:4200',
      }),
    ).toBe('http://localhost:4200');
  });

  it('returns null for file:, capacitor: and empty origins', () => {
    expect(resolveSuperSyncBaseUrl('', { protocol: 'file:', origin: 'null' })).toBeNull();
    expect(
      resolveSuperSyncBaseUrl('', {
        protocol: 'capacitor:',
        origin: 'capacitor://localhost',
      }),
    ).toBeNull();
    expect(resolveSuperSyncBaseUrl('', { protocol: '', origin: '' })).toBeNull();
  });

  it('does not use the origin inside a native app (Capacitor serves https://localhost)', () => {
    expect(
      resolveSuperSyncBaseUrl(
        '',
        { protocol: 'https:', origin: 'https://localhost' },
        true,
      ),
    ).toBeNull();
    expect(resolveSuperSyncBaseUrl('https://sync.example', web, true)).toBe(
      'https://sync.example',
    );
  });

  it('rejects non-http(s) environment values instead of falling back', () => {
    expect(resolveSuperSyncBaseUrl('ftp://x.example', web)).toBeNull();
    expect(resolveSuperSyncBaseUrl('not a url', web)).toBeNull();
  });
});
