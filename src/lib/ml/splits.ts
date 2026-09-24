/**
 * Temporal splitting utilities — the leakage-prevention layer.
 *
 * When behaviour is time-dependent (it is here: mastery grows, difficulty is
 * calibrated over time), random train/test splits leak the future into the past.
 * These helpers split *chronologically* so that, by construction,
 *   max(train timestamp) <= min(test timestamp).
 *
 * Pure and deterministic. Callers pass a `getTime` accessor; ties preserve input
 * order via a stable sort.
 */

function toEpoch(value: number | string | Date): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

/** Stable chronological sort (does not mutate the input). */
export function sortChronologically<T>(items: T[], getTime: (item: T) => number | string | Date): T[] {
  return items
    .map((item, index) => ({ item, index, t: toEpoch(getTime(item)) }))
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map((entry) => entry.item);
}

export interface ChronologicalSplit<T> {
  train: T[];
  validation: T[];
  test: T[];
  boundaries: { trainEnd: number | null; validationEnd: number | null; testStart: number | null };
}

/**
 * Split into train / validation / test by time order. `trainRatio` + `valRatio`
 * define the split points; the remainder is the test set (the most recent data).
 */
export function chronologicalSplit<T>(
  items: T[],
  getTime: (item: T) => number | string | Date,
  opts: { trainRatio?: number; valRatio?: number } = {},
): ChronologicalSplit<T> {
  const trainRatio = opts.trainRatio ?? 0.7;
  const valRatio = opts.valRatio ?? 0.15;
  const ordered = sortChronologically(items, getTime);
  const n = ordered.length;
  const trainEnd = Math.floor(n * trainRatio);
  const valEnd = Math.floor(n * (trainRatio + valRatio));
  const train = ordered.slice(0, trainEnd);
  const validation = ordered.slice(trainEnd, valEnd);
  const test = ordered.slice(valEnd);
  return {
    train,
    validation,
    test,
    boundaries: {
      trainEnd: train.length ? toEpoch(getTime(train[train.length - 1])) : null,
      validationEnd: validation.length ? toEpoch(getTime(validation[validation.length - 1])) : null,
      testStart: test.length ? toEpoch(getTime(test[0])) : null,
    },
  };
}

export interface TimeFold<T> {
  fold: number;
  train: T[];
  test: T[];
  trainEnd: number;
  testStart: number;
}

/**
 * Expanding-window (a.k.a. forward-chaining) cross-validation folds for time
 * series: each fold trains on a growing prefix and tests on the next block, so
 * the model is always validated on the future. Never tests on past data.
 */
export function expandingWindowFolds<T>(
  items: T[],
  getTime: (item: T) => number | string | Date,
  folds = 3,
): TimeFold<T>[] {
  const ordered = sortChronologically(items, getTime);
  const n = ordered.length;
  const result: TimeFold<T>[] = [];
  if (n < folds + 1 || folds < 1) return result;
  // Reserve the first block for the initial training window, then roll forward.
  const blockSize = Math.floor(n / (folds + 1));
  if (blockSize < 1) return result;
  for (let f = 1; f <= folds; f += 1) {
    const trainCount = blockSize * f;
    const testStartIdx = trainCount;
    const testEndIdx = f === folds ? n : blockSize * (f + 1);
    const train = ordered.slice(0, testStartIdx);
    const test = ordered.slice(testStartIdx, testEndIdx);
    if (!train.length || !test.length) continue;
    result.push({
      fold: f,
      train,
      test,
      trainEnd: toEpoch(getTime(train[train.length - 1])),
      testStart: toEpoch(getTime(test[0])),
    });
  }
  return result;
}

/**
 * Assert a split does not leak the future into training. Returns true when every
 * training timestamp precedes (or equals) every test timestamp.
 */
export function isLeakageFree<T>(
  train: T[],
  test: T[],
  getTime: (item: T) => number | string | Date,
): boolean {
  if (!train.length || !test.length) return true;
  const maxTrain = Math.max(...train.map((t) => toEpoch(getTime(t))));
  const minTest = Math.min(...test.map((t) => toEpoch(getTime(t))));
  return maxTrain <= minTest;
}
