import 'package:isar/isar.dart';

part 'schedule_entry.g.dart';

/// Spaced-retrieval + difficulty state per scene (exactly one row per
/// `sceneId`).
///
/// Clinical revision #2 split the old single "stage" into two
/// orthogonal axes:
///
///   * [srInterval]     — how frequently to resurface the scene.
///                        Advances on clean runs, rolls back on error
///                        bursts. Drives [nextDueAt].
///   * [difficultyLevel] — which JSON variant (distractor category,
///                        sequence requirement, item count) to present.
///
/// [cleanRunStreak] is the gate for difficulty advancement: difficulty
/// only moves up after a streak of clean runs, so a single
/// lucky session doesn't push the patient into a harder variant.
///
/// `accessor: 'scheduleEntries'` overrides isar_generator's naive
/// pluralization, which would otherwise emit `scheduleEntrys` (the
/// generator just appends 's' and does not apply the English
/// -y → -ies rule).
@Collection(accessor: 'scheduleEntries')
class ScheduleEntry {
  Id id = Isar.autoIncrement;

  @Index(unique: true)
  late String sceneId;

  DateTime? lastCompletedAt;

  /// When the scene becomes due again. Computed at completion time as
  /// `now + kIntervalDays[srInterval] days`.
  late DateTime nextDueAt;

  /// 0..4; maps through `kIntervalDays` to {1,3,7,14,30} days.
  late int srInterval;

  /// 0..4; maps to the JSON variant index.
  late int difficultyLevel;

  /// Count of consecutive sessions with errorCount ≤ 1.
  /// Resets to 0 on any session with errorCount ≥ 2.
  late int cleanRunStreak;
}
