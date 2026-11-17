import fs from 'node:fs';
import { afterAll } from 'vitest';
import { leftoverDirs } from './helpers.js';

// every test file: remove the upload dirs of the apps it never closed
afterAll(() => {
  for (const dir of leftoverDirs) fs.rmSync(dir, { recursive: true, force: true });
  leftoverDirs.clear();
});
