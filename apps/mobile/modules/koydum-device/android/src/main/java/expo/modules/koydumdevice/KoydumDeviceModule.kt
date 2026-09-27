package expo.modules.koydumdevice

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The two Android switches that decide whether KOYDUM is on time in the
 * background, for Ayarlar → Arka plan.
 *
 * Battery optimisation: without Firebase, "KOYDUM MU?" reaches a closed phone
 * only through the 15-minute background check, and an optimised app is exactly
 * the one Android (and harder still Xiaomi and Samsung) holds back for hours.
 *
 * Exact alarms: the phone's own check-in reminder goes through
 * expo-notifications, which sets an exact alarm only when the app may
 * (ExpoSchedulingDelegate.setupAlarm). Otherwise it is an inexact one Android
 * is free to move, and the 06:30 poke can ring after the 07:00 deadline.
 *
 * The JS side (`src/services/deviceHealth.ts`) looks this module up by name with
 * `requireOptionalNativeModule('KoydumDevice')`, so the four functions below
 * ARE the contract:
 *
 *   isIgnoringBatteryOptimizations(): boolean    — exempt from battery optimisation?
 *   requestIgnoreBatteryOptimizations(): boolean — asks for it; true if a page opened
 *   canScheduleExactAlarms(): boolean            — always true below Android 12
 *   openExactAlarmSettings(): boolean            — KOYDUM's "Alarms & reminders"
 *                                                  page; true if it opened
 */
class KoydumDeviceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KoydumDevice")

    AsyncFunction("isIgnoringBatteryOptimizations") {
      isIgnoringBatteryOptimizations(context)
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      requestIgnoreBatteryOptimizations(context)
    }

    AsyncFunction("canScheduleExactAlarms") {
      canScheduleExactAlarms(context)
    }

    AsyncFunction("openExactAlarmSettings") {
      openExactAlarmSettings(context)
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  companion object {
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
      val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
      return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * The one-tap system dialog for KOYDUM itself. Play's policy keeps this
     * dialog for apps whose core job needs it (lint says so as "BatteryLife");
     * KOYDUM is a sideloaded APK whose only delivery path without Firebase is
     * the background check. Some ROMs drop the dialog, so the full list of
     * apps is the fallback.
     */
    @SuppressLint("BatteryLife")
    fun requestIgnoreBatteryOptimizations(context: Context): Boolean {
      val ask = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri(context))
      return start(context, ask) ||
        start(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    fun canScheduleExactAlarms(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
      return alarms.canScheduleExactAlarms()
    }

    /**
     * Android 12+ keeps the switch on a page of its own (granted at install up
     * to Android 13, off by default from 14). Below 12 there is nothing to grant.
     */
    fun openExactAlarmSettings(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
      val page = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri(context))
      return start(context, page) ||
        start(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri(context)))
    }

    private fun packageUri(context: Context): Uri = Uri.parse("package:" + context.packageName)

    /** The React context is not an activity, so a settings page needs a task of its own. */
    private fun start(context: Context, intent: Intent): Boolean {
      return try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      } catch (_: Exception) {
        false
      }
    }
  }
}
