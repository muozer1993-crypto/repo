export const SHARED_VERSION = '1.0.0';

export * from './types';
export * from './schemas';
export * from './scoring';
export * from './time';
export * from './banned';
export * from './levels';

// `clampLevel` is re-exported explicitly so that a future `export * from './taunts'`
// defining the same name (SPEC 1.4) cannot produce an ambiguous-export error.
export { clampLevel } from './levels';

// Data modules produced by the catalog/taunts/copy task — add when they exist:
// export * from './catalog';
// export * from './taunts';
// export * from './copy';
