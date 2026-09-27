package expo.modules.koydumsteps

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.fitness.FitnessLocal
import com.google.android.gms.fitness.LocalRecordingClient
import com.google.android.gms.fitness.data.LocalDataType
import com.google.android.gms.fitness.data.LocalField
import com.google.android.gms.fitness.request.LocalDataReadRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Daily steps from Google Play services' "Recording API on mobile".
 *
 * Why not the step sensor: since Android 9 an app in the background receives no
 * events from on-change sensors, so KOYDUM could only count while it was open.
 * The Recording API is Play services counting on the phone itself, all day,
 * app open or not, and it keeps ten days of history — the Android counterpart of
 * iOS Core Motion. No Google account, no network, only ACTIVITY_RECOGNITION.
 *
 * The JS side (`src/services/steps.native.ts`) looks the module up by name, so
 * these three functions are the contract:
 *
 *   status(): "ok" | "no-permission" | "play-services" | "unsupported"
 *   subscribe(): boolean      — start recording (idempotent); data exists only
 *                               from the first successful subscribe on
 *   dailySteps(days): [{ dayKey, steps }] newest first, today up to now
 */
class KoydumStepsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KoydumSteps")

    AsyncFunction("status") {
      status(context)
    }

    AsyncFunction("subscribe") { promise: Promise ->
      if (status(context) != "ok") {
        promise.resolve(false)
        return@AsyncFunction
      }
      try {
        FitnessLocal.getLocalRecordingClient(context)
          .subscribe(LocalDataType.TYPE_STEP_COUNT_DELTA)
          .addOnSuccessListener { promise.resolve(true) }
          .addOnFailureListener { promise.resolve(false) }
      } catch (_: Exception) {
        promise.resolve(false)
      }
    }

    AsyncFunction("dailySteps") { days: Int, promise: Promise ->
      if (status(context) != "ok") {
        promise.resolve(emptyList<Map<String, Any>>())
        return@AsyncFunction
      }
      val count = days.coerceIn(1, MAX_DAYS)
      val now = System.currentTimeMillis()
      val start = startOfDay(now, count - 1)
      try {
        val request = LocalDataReadRequest.Builder()
          .aggregate(LocalDataType.TYPE_STEP_COUNT_DELTA)
          .bucketByTime(1, TimeUnit.DAYS)
          .setTimeRange(start / 1000L, now / 1000L, TimeUnit.SECONDS)
          .build()
        FitnessLocal.getLocalRecordingClient(context)
          .readData(request)
          .addOnSuccessListener { response ->
            val totals = LinkedHashMap<String, Int>()
            for (bucket in response.buckets) {
              // buckets are 24 h from local midnight; the middle of one is
              // always inside the right local day, DST or not
              val middle = bucket.getStartTime(TimeUnit.MILLISECONDS) + 12L * 60 * 60 * 1000
              val key = dayKeyOf(middle)
              var steps = 0
              for (dataSet in bucket.dataSets) {
                for (point in dataSet.dataPoints) {
                  steps += try {
                    point.getValue(LocalField.FIELD_STEPS).asInt()
                  } catch (_: Exception) {
                    0
                  }
                }
              }
              totals[key] = (totals[key] ?: 0) + steps
            }
            // every day in the window gets a row, newest first, so "0 today"
            // is an answer rather than a missing one
            val out = ArrayList<Map<String, Any>>(count)
            for (offset in 0 until count) {
              val key = dayKeyOf(startOfDay(now, offset) + 12L * 60 * 60 * 1000)
              out.add(mapOf("dayKey" to key, "steps" to (totals[key] ?: 0)))
            }
            promise.resolve(out)
          }
          .addOnFailureListener { promise.resolve(emptyList<Map<String, Any>>()) }
      } catch (_: Exception) {
        promise.resolve(emptyList<Map<String, Any>>())
      }
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  companion object {
    private const val MAX_DAYS = 10 // what the Recording API keeps

    fun status(context: Context): String {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        context.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED
      ) {
        return "no-permission"
      }
      val play = try {
        GoogleApiAvailabilityLight.getInstance()
          .isGooglePlayServicesAvailable(context, LocalRecordingClient.LOCAL_RECORDING_CLIENT_STEPS_MIN_VERSION_CODE)
      } catch (_: Exception) {
        ConnectionResult.SERVICE_MISSING
      }
      return when (play) {
        ConnectionResult.SUCCESS -> "ok"
        ConnectionResult.SERVICE_MISSING, ConnectionResult.SERVICE_INVALID -> "unsupported"
        else -> "play-services"
      }
    }

    private fun startOfDay(now: Long, daysBack: Int): Long {
      val cal = Calendar.getInstance()
      cal.timeInMillis = now
      cal.add(Calendar.DAY_OF_YEAR, -daysBack)
      cal.set(Calendar.HOUR_OF_DAY, 0)
      cal.set(Calendar.MINUTE, 0)
      cal.set(Calendar.SECOND, 0)
      cal.set(Calendar.MILLISECOND, 0)
      return cal.timeInMillis
    }

    private fun dayKeyOf(millis: Long): String {
      val cal = Calendar.getInstance()
      cal.timeInMillis = millis
      return String.format(
        Locale.US,
        "%04d-%02d-%02d",
        cal.get(Calendar.YEAR),
        cal.get(Calendar.MONTH) + 1,
        cal.get(Calendar.DAY_OF_MONTH),
      )
    }
  }
}
