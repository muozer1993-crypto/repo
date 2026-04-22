import 'package:isar/isar.dart';

part 'app_open_event.g.dart';

/// One row per app cold/warm start.
///
/// Engagement signal only — lets the therapist see whether the patient
/// is opening the app regularly (and at which time windows) versus
/// just skimming through it. No PII captured.
@collection
class AppOpenEvent {
  Id id = Isar.autoIncrement;

  @Index()
  late String profileId;

  @Index()
  late DateTime at;

  /// 'sabah' | 'oglen' | 'ikindi' | 'aksam' | 'dinlenme'.
  /// String form matches Supabase column; see `time_window.dart`.
  late String timeWindow;

  DateTime? syncedAt;
}

/// Pending report-trigger bookkeeping.
///
/// Separate from [AppOpenEvent] because it represents state (when did
/// we last try/succeed to trigger the weekly report Edge Function)
/// rather than an event stream.
@collection
class ReportTriggerState {
  /// Fixed id=1 — we only ever keep one row. Isar requires [Id]; we
  /// set it explicitly so that upserts are simple.
  Id id = 1;

  /// Null until the first successful trigger response.
  DateTime? lastTriggeredAt;

  /// When to next attempt. Increases on failures via exponential
  /// backoff (2h, 6h, 1d, 2d, 7d) — see WeeklyTriggerController.
  DateTime? nextRetryAt;

  /// 0 after success; increments on each consecutive failure.
  int consecutiveFailures = 0;
}
