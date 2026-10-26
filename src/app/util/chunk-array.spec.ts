import { chunkArrayKeepingRuns } from './chunk-array';

describe('chunkArrayKeepingRuns', () => {
  const isM = (s: string): boolean => s.startsWith('m');

  it('chunks like chunkArray without runs', () => {
    expect(chunkArrayKeepingRuns(['a', 'b', 'c', 'd', 'e'], 2, isM)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('starts a new batch so a run that fits is never split', () => {
    expect(chunkArrayKeepingRuns(['a', 'b', 'm1', 'm2', 'm3', 'c'], 4, isM)).toEqual([
      ['a', 'b'],
      ['m1', 'm2', 'm3', 'c'],
    ]);
  });

  it('keeps filling the batch when the run fits after earlier items', () => {
    expect(chunkArrayKeepingRuns(['a', 'm1', 'm2', 'b'], 4, isM)).toEqual([
      ['a', 'm1', 'm2', 'b'],
    ]);
  });

  it('splits a run larger than one batch (cannot be atomic)', () => {
    expect(chunkArrayKeepingRuns(['a', 'm1', 'm2', 'm3'], 2, isM)).toEqual([
      ['a'],
      ['m1', 'm2'],
      ['m3'],
    ]);
  });
});
