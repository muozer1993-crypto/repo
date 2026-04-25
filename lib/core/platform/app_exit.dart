import 'dart:io' as io;

import 'package:flutter/services.dart';

/// v2 — single entry point for "actually close the app".
///
/// Android only on real devices: invokes the
/// `ergoterapi/exit#exitAndClearTask` method channel which calls
/// `Activity.finishAndRemoveTask()`. That finishes the activity AND
/// removes the card from system Recents, which is what patients
/// expect when they tap Çık. We fall through to `io.exit(0)` after a
/// short timeout so the process is guaranteed to terminate even if
/// the channel call hangs (rare, but worth defending against on a
/// patient-facing app).
///
/// iOS support is intentionally a no-op — Apple HIG forbids
/// programmatic quit. The caller can still navigate home.
const _exitChannel = MethodChannel('ergoterapi/exit');

Future<void> hardExitApp() async {
  if (io.Platform.isAndroid) {
    try {
      await _exitChannel
          .invokeMethod<void>('exitAndClearTask')
          .timeout(const Duration(milliseconds: 200));
    } catch (_) {
      // channel not registered (debug hot-reload edge case) or
      // timed out — fall through to the unconditional exit below.
    }
  }
  if (io.Platform.isAndroid || io.Platform.isIOS) {
    io.exit(0);
  }
}
