export const chunkArray = <T>(arr: T[], chunkSize: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
};

/**
 * Like chunkArray, but a contiguous run of items matching `isRunItem` starts a new
 * chunk when it would not fit into the current one, so a run of up to chunkSize items
 * always lands in a single chunk. Longer runs are split.
 */
export const chunkArrayKeepingRuns = <T>(
  arr: T[],
  chunkSize: number,
  isRunItem: (item: T) => boolean,
): T[][] => {
  const chunks: T[][] = [];
  let cur: T[] = [];
  arr.forEach((item, i) => {
    if (isRunItem(item) && (i === 0 || !isRunItem(arr[i - 1]))) {
      let runLength = 1;
      while (i + runLength < arr.length && isRunItem(arr[i + runLength])) runLength++;
      if (cur.length > 0 && cur.length + runLength > chunkSize) {
        chunks.push(cur);
        cur = [];
      }
    }
    if (cur.length === chunkSize) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(item);
  });
  if (cur.length > 0) chunks.push(cur);
  return chunks;
};
