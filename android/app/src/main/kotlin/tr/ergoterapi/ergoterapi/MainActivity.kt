package tr.ergoterapi.ergoterapi

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * v2 — exposes `ergoterapi/exit` MethodChannel so Dart can fully
 * close the app. `exitAndClearTask` calls
 * `Activity.finishAndRemoveTask()` which finishes the activity AND
 * drops it from the system Overview/Recents screen — the v1 path of
 * `SystemNavigator.pop()` only finished the activity but left the
 * recents card visible, which patients/caregivers reported as
 * "uygulama hâlâ açık görünüyor".
 *
 * On API 21+ (we target API 23+) finishAndRemoveTask is supported
 * universally; older devices fall back to plain finish().
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ergoterapi/exit",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "exitAndClearTask" -> {
                    finishAndRemoveTask()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }
}
