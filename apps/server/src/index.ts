/**
 * The server's entry: `npm run server` (tsx watch), `npm start -w apps/server`, and
 * the process npm run internet supervises. The boot itself is main.ts.
 *
 * main.ts is imported here, not statically: a package that a `git pull` added and
 * `npm install` never fetched fails while main.ts loads, before any code of ours
 * runs, and a static import would leave Node's English stack as the only report.
 * This module imports nothing that could be missing.
 */
import { startupErrorMessage } from './listenError.js';

import('./main.js')
  .then((boot) => boot.main())
  .catch((err: unknown) => {
    // the common failures get one Turkish line; anything else needs its stack
    const known = startupErrorMessage(err);
    if (known) console.error(known.text);
    else console.error('KOYDUM sunucusu başlatılamadı:', err);
    process.exit(known?.code ?? 1);
  });
