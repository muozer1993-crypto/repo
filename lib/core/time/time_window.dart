/// Day partitioned into ADL-appropriate windows.
///
/// Window boundaries (all Turkish cultural norms):
///   06:00 – 10:59  → sabah  (breakfast, morning routines)
///   11:00 – 14:59  → oglen  (lunch)
///   15:00 – 18:59  → ikindi (afternoon tea — "çay saati")
///   19:00 – 22:59  → aksam  (evening, wind-down)
///   23:00 – 05:59  → dinlenme (sleep time — game soft-locked)
enum TimeWindow { sabah, oglen, ikindi, aksam, dinlenme }

/// Pure function mapping a wall-clock [now] to its [TimeWindow].
///
/// Kept pure (no clock reads internally) so it is trivially testable:
/// exhaustive per-hour tests live in `test/core/time_window_test.dart`.
TimeWindow windowFor(DateTime now) {
  final h = now.hour;
  if (h >= 6 && h < 11) return TimeWindow.sabah;
  if (h >= 11 && h < 15) return TimeWindow.oglen;
  if (h >= 15 && h < 19) return TimeWindow.ikindi;
  if (h >= 19 && h < 23) return TimeWindow.aksam;
  return TimeWindow.dinlenme;
}

/// String id used in JSON scene files and as the persisted
/// `AppOpenEvent.timeWindow` column. Kept separate from the enum name so we
/// can refactor Dart names without a DB migration.
String timeWindowId(TimeWindow w) => switch (w) {
      TimeWindow.sabah => 'sabah',
      TimeWindow.oglen => 'oglen',
      TimeWindow.ikindi => 'ikindi',
      TimeWindow.aksam => 'aksam',
      TimeWindow.dinlenme => 'dinlenme',
    };

TimeWindow? timeWindowFromId(String id) => switch (id) {
      'sabah' => TimeWindow.sabah,
      'oglen' => TimeWindow.oglen,
      'ikindi' => TimeWindow.ikindi,
      'aksam' => TimeWindow.aksam,
      'dinlenme' => TimeWindow.dinlenme,
      _ => null,
    };
