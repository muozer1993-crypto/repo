package expo.modules.koydumscreentime

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Calendar
import java.util.Locale

/**
 * Screen time as Android itself counts it, for the Ekran Süresi çelınc.
 *
 * The JS side (`src/services/screenTime.ts`) looks this module up by name with
 * `requireOptionalNativeModule('KoydumScreenTime')`, so the three functions
 * below ARE the contract:
 *
 *   hasPermission(): boolean        — usage access granted in system settings?
 *   requestPermission(): boolean    — opens that settings page; true if it could
 *   dailyMinutes(days): [{dayKey, minutes}] — foreground minutes per local day,
 *                                     newest first, at most `days` entries
 *
 * Minutes are summed from `UsageStatsManager.queryEvents`: every app's
 * foreground interval (ACTIVITY_RESUMED → ACTIVITY_PAUSED/STOPPED, or the
 * screen going dark / the device shutting down) is clipped to local-midnight
 * day buckets. That is how Digital Wellbeing arrives at its "screen time"
 * number too, and unlike the daily buckets of `queryUsageStats` it lines up
 * with the calendar day the çelınc scores.
 */
class KoydumScreenTimeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KoydumScreenTime")

    AsyncFunction("hasPermission") {
      hasUsageAccess(context)
    }

    AsyncFunction("requestPermission") {
      openUsageAccessSettings(context)
    }

    AsyncFunction("dailyMinutes") { days: Int ->
      if (!hasUsageAccess(context)) {
        emptyList<Map<String, Any>>()
      } else {
        dailyForegroundMinutes(context, days.coerceIn(1, MAX_DAYS))
      }
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  companion object {
    private const val MAX_DAYS = 14

    // UsageEvents.Event type codes, by value so the file compiles against any
    // compileSdk and never trips the NewApi lint: 1/2 are MOVE_TO_FOREGROUND /
    // MOVE_TO_BACKGROUND (renamed ACTIVITY_RESUMED / ACTIVITY_PAUSED in API 29),
    // 23 is ACTIVITY_STOPPED (API 29), 16/17 SCREEN_INTERACTIVE /
    // SCREEN_NON_INTERACTIVE (API 28), 26 DEVICE_SHUTDOWN (API 26).
    private const val EVENT_RESUMED = 1
    private const val EVENT_PAUSED = 2
    private const val EVENT_STOPPED = 23
    private const val EVENT_SCREEN_OFF = 17
    private const val EVENT_SHUTDOWN = 26

    /** PACKAGE_USAGE_STATS is granted per app from Settings, not at runtime. */
    fun hasUsageAccess(context: Context): Boolean {
      val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
      } else {
        @Suppress("DEPRECATION")
        appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
      }
      return if (mode == AppOpsManager.MODE_DEFAULT) {
        context.checkCallingOrSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) ==
          PackageManager.PERMISSION_GRANTED
      } else {
        mode == AppOpsManager.MODE_ALLOWED
      }
    }

    /** Sends the user to the "usage access" list; they pick KOYDUM there. */
    fun openUsageAccessSettings(context: Context): Boolean {
      val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      return try {
        context.startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
    }

    private fun startOfDay(now: Long, daysBack: Int): Calendar {
      val cal = Calendar.getInstance()
      cal.timeInMillis = now
      cal.add(Calendar.DAY_OF_YEAR, -daysBack)
      cal.set(Calendar.HOUR_OF_DAY, 0)
      cal.set(Calendar.MINUTE, 0)
      cal.set(Calendar.SECOND, 0)
      cal.set(Calendar.MILLISECOND, 0)
      return cal
    }

    private fun dayKeyOf(cal: Calendar): String =
      String.format(
        Locale.US,
        "%04d-%02d-%02d",
        cal.get(Calendar.YEAR),
        cal.get(Calendar.MONTH) + 1,
        cal.get(Calendar.DAY_OF_MONTH),
      )

    /**
     * Foreground minutes per local day for the last `days` days (today first).
     * Days with nothing recorded are reported as 0 rather than omitted, so the
     * server can tell "the phone says zero" from "the phone said nothing".
     *
     * Intervals are tracked per ACTIVITY (package + class), not per package: when
     * an app moves from one screen to another, Android reports the new screen's
     * ACTIVITY_RESUMED before the old one's ACTIVITY_STOPPED, so a per-package
     * bookkeeping would close the app's interval on that STOPPED and lose all the
     * time until the next switch. The per-activity intervals of one package are
     * merged afterwards, so the brief overlap during a switch is counted once.
     */
    fun dailyForegroundMinutes(context: Context, days: Int): List<Map<String, Any>> {
      val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
        ?: return emptyList()
      val now = System.currentTimeMillis()

      // day boundaries, oldest first: starts[i] is midnight opening bucket i
      val starts = LongArray(days + 1)
      for (i in 0 until days) starts[i] = startOfDay(now, days - 1 - i).timeInMillis
      starts[days] = now

      val ignored = ignoredPackages(context)
      val open = HashMap<String, Long>() // "pkg/activity" → foreground since
      val intervals = HashMap<String, MutableList<LongArray>>() // pkg → [start, end]

      fun close(key: String, pkg: String, at: Long) {
        val since = open.remove(key) ?: return
        if (at > since) intervals.getOrPut(pkg) { ArrayList() }.add(longArrayOf(since, at))
      }

      // Start one local day early: a session that began before the first
      // midnight has its RESUMED event there, and without it the part after
      // midnight would be lost (and dailyMinutes(1) would disagree with
      // dailyMinutes(7) about today). addInterval clips the early part away.
      val queryFrom = startOfDay(now, days).timeInMillis
      val events = usage.queryEvents(queryFrom, now)
      val event = UsageEvents.Event()
      while (events.hasNextEvent()) {
        events.getNextEvent(event)
        val pkg = event.packageName ?: continue
        val key = pkg + "/" + (event.className ?: "")
        when (event.eventType) {
          EVENT_RESUMED -> {
            if (pkg !in ignored && !open.containsKey(key)) open[key] = event.timeStamp
          }
          EVENT_PAUSED, EVENT_STOPPED -> close(key, pkg, event.timeStamp)
          EVENT_SCREEN_OFF, EVENT_SHUTDOWN -> {
            for (k in ArrayList(open.keys)) close(k, k.substringBefore('/'), event.timeStamp)
          }
        }
      }
      // whatever is still in the foreground counts up to this moment
      for (k in ArrayList(open.keys)) close(k, k.substringBefore('/'), now)

      val totals = LongArray(days)
      fun addInterval(from: Long, to: Long) {
        for (i in 0 until days) {
          val lo = maxOf(from, starts[i])
          val hi = minOf(to, starts[i + 1])
          if (hi > lo) totals[i] += hi - lo
        }
      }
      for (list in intervals.values) {
        // merge overlapping intervals of the same package before counting
        list.sortBy { it[0] }
        var curStart = -1L
        var curEnd = -1L
        for (iv in list) {
          if (curStart < 0) {
            curStart = iv[0]; curEnd = iv[1]
          } else if (iv[0] <= curEnd) {
            if (iv[1] > curEnd) curEnd = iv[1]
          } else {
            addInterval(curStart, curEnd)
            curStart = iv[0]; curEnd = iv[1]
          }
        }
        if (curStart >= 0) addInterval(curStart, curEnd)
      }

      val out = ArrayList<Map<String, Any>>(days)
      for (i in days - 1 downTo 0) {
        val cal = Calendar.getInstance()
        cal.timeInMillis = starts[i]
        out.add(
          mapOf(
            "dayKey" to dayKeyOf(cal),
            "minutes" to (totals[i] / 60_000L).toInt(),
          ),
        )
      }
      return out
    }

    /**
     * The launcher and the system UI are "the phone", not an app you are using;
     * Digital Wellbeing leaves them out of screen time and so do we.
     */
    private fun ignoredPackages(context: Context): Set<String> {
      val set = HashSet<String>()
      set.add("com.android.systemui")
      try {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val resolved = context.packageManager.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)
        resolved?.activityInfo?.packageName?.let { set.add(it) }
      } catch (_: Exception) {
        // no launcher to exclude; count everything
      }
      return set
    }
  }
}
