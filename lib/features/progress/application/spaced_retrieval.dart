import '../../game/domain/scene.dart';
import '../domain/schedule_entry.dart';

/// Days between successive scheduled resurfaces of a scene. Index maps
/// to [ScheduleEntry.srInterval].
const List<int> kIntervalDays = [1, 3, 7, 14, 30];

/// v2 — during the first 72 hours after the profile's createdAt the
/// scheduler locks difficultyLevel at 0 so the patient can anchor on
/// the easiest variant before any advancement. [isInLearningPhase]
/// makes this decision testable without pulling in the whole
/// scheduler controller.
const Duration kLearningPhase = Duration(hours: 72);

bool isInLearningPhase({
  required DateTime profileCreatedAt,
  required DateTime now,
}) =>
    now.isBefore(profileCreatedAt.add(kLearningPhase));

/// Clinical revision #2: the two orthogonal axes.
///
/// [srInterval] — how frequently the scene resurfaces (1/3/7/14/30 days).
/// [difficultyLevel] — which JSON variant of the scene to present.
///
/// Each axis is a pure function of the latest session's [errorCount]
/// (and, for difficulty, the [cleanRunStreak] so a single lucky session
/// doesn't push the patient into a harder variant).
///
/// v2 orthogonality — the scheduler must not serve the same Game-2 type
/// twice on the same day. [pickOrthogonalGame2Type] is a pure helper
/// the scheduler can call with the scene's native [Game2Type] and the
/// set of types already played today; it returns the scene's own type
/// unless the set already includes it, in which case it returns null
/// (meaning "skip Game-2 for this entry"). Scheduler decides whether
/// null means "retry", "use a different scene", or "serve Game-1 only".

/// Pure step for the frequency axis.
///
/// errorCount ≤ 1 → advance (+1), errorCount ≥ 4 → roll back (−1).
/// In between: stay. Clamp to [0, 4].
int nextInterval(int prev, {required int errorCount}) {
  if (errorCount <= 1) return (prev + 1).clamp(0, 4);
  if (errorCount >= 4) return (prev - 1).clamp(0, 4);
  return prev;
}

/// Pure step for the within-scene difficulty axis.
///
/// Advances only when the patient completes with ≤ 1 errors AND already
/// has a prior clean run on record (so the streak is ≥ 1 GOING IN).
/// Rolls back immediately on ≥ 4 errors.
int nextDifficulty(
  int prev, {
  required int errorCount,
  required int cleanRunStreak,
}) {
  if (errorCount <= 1 && cleanRunStreak >= 1) {
    return (prev + 1).clamp(0, 4);
  }
  if (errorCount >= 4) {
    return (prev - 1).clamp(0, 4);
  }
  return prev;
}

/// Result of applying a completed session's errorTotal (Game-1 +
/// Game-2 combined) to an existing [ScheduleEntry]. Returns a NEW
/// entry — callers must persist it.
///
/// Deliberately returns a fresh object rather than mutating so the
/// algorithm stays trivially unit-testable (no Isar, no side effects).
///
/// v2 — when [lockDifficulty] is true (learning phase), the
/// difficulty axis stays at its current value regardless of
/// errorTotal. The srInterval axis still advances so missed-a-day
/// penalties still apply during learning phase.
ScheduleEntry onCompletion(
  ScheduleEntry prev, {
  required int errorCount,
  required DateTime now,
  bool lockDifficulty = false,
}) {
  final newInterval = nextInterval(prev.srInterval, errorCount: errorCount);
  final newDifficulty = lockDifficulty
      ? prev.difficultyLevel
      : nextDifficulty(
          prev.difficultyLevel,
          errorCount: errorCount,
          cleanRunStreak: prev.cleanRunStreak,
        );
  final newStreak = errorCount <= 1 ? prev.cleanRunStreak + 1 : 0;

  return ScheduleEntry()
    ..id = prev.id
    ..sceneId = prev.sceneId
    ..lastCompletedAt = now
    ..nextDueAt = now.add(Duration(days: kIntervalDays[newInterval]))
    ..srInterval = newInterval
    ..difficultyLevel = newDifficulty
    ..cleanRunStreak = newStreak;
}

/// v2 — orthogonality helper. Returns the scene's declared Game-2
/// type if it hasn't been played yet today, otherwise null.
///
/// Scheduler semantics: null → "don't serve Game-2 this entry". The
/// next dilim will naturally serve a different scene with a different
/// Game-2 type, so the patient sees variety across the day.
Game2Type? pickOrthogonalGame2Type({
  required Game2Type sceneNative,
  required Set<Game2Type> playedToday,
}) {
  if (playedToday.contains(sceneNative)) return null;
  return sceneNative;
}

/// Factory for the first-ever session on a scene — before any
/// ScheduleEntry has been persisted.
ScheduleEntry freshEntry(String sceneId, {required DateTime now}) {
  return ScheduleEntry()
    ..sceneId = sceneId
    ..nextDueAt = now
    ..srInterval = 0
    ..difficultyLevel = 0
    ..cleanRunStreak = 0;
}
