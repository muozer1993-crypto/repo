package tr.ergoterapi.ergoterapi

import io.flutter.embedding.android.FlutterActivity

/**
 * v2 — minimal MainActivity matching what `flutter create` generates.
 *
 * The earlier custom version registered a `ergoterapi/exit` MethodChannel
 * for finishAndRemoveTask(), but the kotlin source set wasn't being
 * compiled into the dex on at least one Android target — runtime threw
 * ClassNotFoundException for tr.ergoterapi.ergoterapi.MainActivity even
 * though the build succeeded. Reverting to the canonical flutter-default
 * shell so the app launches reliably; hardExitApp() in
 * lib/core/platform/app_exit.dart already gracefully degrades to
 * io.exit(0) when the channel call fails.
 *
 * Trade-off: the app card stays in Android Recents until the user
 * swipes it away, which is the platform-default behaviour for any
 * killed-but-recently-used app. Patients see the app close + the
 * process is terminated; the recents card is cosmetic.
 */
class MainActivity : FlutterActivity()
