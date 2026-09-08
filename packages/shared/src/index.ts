export const SHARED_VERSION = '1.0.0';

export * from './types';
export * from './schemas';
export * from './scoring';
export * from './time';
export * from './text';
export * from './banned';
// clampLevel() lives in levels.ts (SPEC 1.4 lists it under taunts.ts; taunts.ts imports it from here).
export * from './levels';
export * from './catalog';
export * from './taunts';
export * from './copy';
