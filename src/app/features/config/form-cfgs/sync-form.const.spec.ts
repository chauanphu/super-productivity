import { FormlyFieldConfig } from '@ngx-formly/core';
import { SYNC_FORM } from './sync-form.const';

describe('SYNC_FORM SuperSync server URL', () => {
  const superSyncBaseUrl = (): FormlyFieldConfig => {
    const superSync = SYNC_FORM.items!.find((f) => f.key === 'superSync')!;
    const advanced = superSync.fieldGroup!.find((f) => f.type === 'collapsible')!;
    return advanced.fieldGroup!.find((f) => f.key === 'baseUrl')!;
  };
  const isDisabled = (model: Record<string, unknown>): boolean => {
    const expr = superSyncBaseUrl().expressions?.['props.disabled'] as (
      f: FormlyFieldConfig,
    ) => boolean;
    return expr({ model } as FormlyFieldConfig);
  };

  it('is read-only while a session (token) exists', () => {
    expect(isDisabled({ accessToken: 'tok' })).toBe(true);
  });

  it('is editable without a session', () => {
    expect(isDisabled({ accessToken: '' })).toBe(false);
    expect(isDisabled({})).toBe(false);
  });
});
