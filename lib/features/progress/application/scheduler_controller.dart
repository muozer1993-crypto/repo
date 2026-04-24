import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../game/application/scene_controller.dart';
import '../../game/data/scene_repository.dart';
import '../../game/domain/scene.dart';
import '../../profile/data/profile_repository.dart';
import '../data/schedule_repository.dart';
import '../domain/schedule_entry.dart';
import '../domain/session_log.dart';
import 'spaced_retrieval.dart';

/// What the home screen shows "Başla" for, plus the args the scene
/// player needs when launched.
class LaunchPlan {
  LaunchPlan({
    required this.window,
    required this.scene,
    required this.variant,
    required this.scheduleEntry,
    this.learningPhase = false,
  });

  final TimeWindow window;
  final Scene scene;
  final DifficultyVariant variant;
  final ScheduleEntry scheduleEntry;

  /// v2 — true while the patient is still in the first 72h after
  /// profile creation. The session controller applies
  /// onCompletion(..., lockDifficulty: true) so the variant stays
  /// at its current level across these days.
  final bool learningPhase;

  SceneArgs toArgs() => SceneArgs(
        scene: scene,
        variant: variant,
        scheduleEntry: scheduleEntry,
      );
}

/// Builds the [LaunchPlan] for the current moment.
///
/// v2 responsibilities:
///   * Compute the current [TimeWindow] via the injected clock.
///   * Look up (or create) the matching scene's [ScheduleEntry].
///   * During the first 72h, pin the variant to level 0 regardless of
///     ScheduleEntry.difficultyLevel.
///   * Outside learning phase, pick the variant indexed by the entry's
///     difficultyLevel.
///
/// Returns null during [TimeWindow.dinlenme] when the home screen
/// should render the soft-locked "İyi geceler" state instead of a
/// "Başla" button.
final launchPlanProvider = FutureProvider<LaunchPlan?>((ref) async {
  final now = ref.watch(clockProvider)();
  final window = windowFor(now);
  if (window == TimeWindow.dinlenme) return null;

  final scene = await ref.watch(sceneRepositoryProvider).byWindow(window);
  if (scene == null) return null;

  final entry =
      await ref.watch(scheduleRepositoryProvider).forScene(scene.id, now: now);

  final profile = ref.watch(patientProfileProvider).value;
  final inLearning = profile == null
      ? false
      : isInLearningPhase(
          profileCreatedAt: profile.createdAt,
          now: now,
        );
  final effectiveLevel = inLearning ? 0 : entry.difficultyLevel;
  final variant = scene.variantFor(effectiveLevel);

  return LaunchPlan(
    window: window,
    scene: scene,
    variant: variant,
    scheduleEntry: entry,
    learningPhase: inLearning,
  );
});

/// Bypass plan used by the night-time "Yine de bir oyun oyna" link.
/// Always returns the evening scene at the patient's current
/// difficulty, regardless of the clock.
final nightBypassPlanProvider = FutureProvider<LaunchPlan?>((ref) async {
  final now = ref.watch(clockProvider)();
  final scene =
      await ref.watch(sceneRepositoryProvider).byWindow(TimeWindow.aksam);
  if (scene == null) return null;
  final entry =
      await ref.watch(scheduleRepositoryProvider).forScene(scene.id, now: now);
  return LaunchPlan(
    window: TimeWindow.aksam,
    scene: scene,
    variant: scene.variantFor(entry.difficultyLevel),
    scheduleEntry: entry,
  );
});

// ===========================================================================
// v2 — Bonus rotation & post-session offer policy
// ===========================================================================

/// Day-of-week × time-window → bonusSceneId.
///
/// v2 carries one concrete bonus per dilim (see assets/scenes/bonus/
/// JSONs) so rotation is currently "every day the same bonus per
/// window". The shape is kept as a function so later content drops
/// (commit 4+ evolution) can swap in a multi-day rotation without
/// touching callers.
String? bonusSceneIdFor({
  required TimeWindow window,
  required DateTime date,
}) {
  switch (window) {
    case TimeWindow.sabah:
      return 'bonus_sabah_pair';
    case TimeWindow.oglen:
      return 'bonus_oglen_find';
    case TimeWindow.ikindi:
      return 'bonus_ikindi_tap';
    case TimeWindow.aksam:
      return 'bonus_aksam_explore';
    case TimeWindow.dinlenme:
      return 'bonus_night_explore';
  }
}

/// Snapshot of "what did the patient do today" used by [shouldOfferBonus]
/// and the orthogonality check in spaced_retrieval.dart.
class TodaySessionSnapshot {
  const TodaySessionSnapshot({
    required this.completedByWindow,
    required this.bonusPlayedByWindow,
    required this.game2TypesPlayed,
  });

  /// Map from time window → how many SessionLog rows completed=true
  /// today for a scene in that window.
  final Map<TimeWindow, int> completedByWindow;

  /// Map from time window → true iff the patient has played a
  /// BonusPlayEvent during today's instance of that window.
  final Map<TimeWindow, bool> bonusPlayedByWindow;

  /// Set of Game-2 types whose game2Completed is true today.
  final Set<Game2Type> game2TypesPlayed;
}

/// Loads today's snapshot from Isar. Lives next to the scheduler
/// because its shape is scheduler-specific — different from what
/// the weekly report aggregator needs.
Future<TodaySessionSnapshot> loadTodaySnapshot({
  required Isar isar,
  required String profileId,
  required DateTime now,
}) async {
  final startOfDay = DateTime(now.year, now.month, now.day);

  final sessions = await isar.sessionLogs
      .filter()
      .profileIdEqualTo(profileId)
      .startedAtGreaterThan(startOfDay)
      .findAll();

  final completedByWindow = <TimeWindow, int>{};
  final g2 = <Game2Type>{};
  for (final s in sessions) {
    final w = _windowFromSceneId(s.sceneId);
    if (w != null && s.completed) {
      completedByWindow[w] = (completedByWindow[w] ?? 0) + 1;
    }
    if (s.game2Completed && s.game2Type != null) {
      final t = game2TypeFromIdSafe(s.game2Type!);
      if (t != null) g2.add(t);
    }
  }

  final bonusPlayedByWindow = <TimeWindow, bool>{};
  // BonusPlayEvent load — we reach for the collection by accessor name
  // to avoid an extra import round-trip.
  // ignore: avoid_dynamic_calls
  final bonuses = await (isar as dynamic)
      .bonusPlayEvents
      .filter()
      .profileIdEqualTo(profileId)
      .startedAtGreaterThan(startOfDay)
      .findAll();
  for (final ev in bonuses as Iterable) {
    final tw = timeWindowFromId((ev.timeWindow as String));
    if (tw == null) continue;
    bonusPlayedByWindow[tw] = true;
  }

  return TodaySessionSnapshot(
    completedByWindow: completedByWindow,
    bonusPlayedByWindow: bonusPlayedByWindow,
    game2TypesPlayed: g2,
  );
}

/// Scene-id → window mapping. Bonus scenes are never returned here;
/// only main dilim scenes (bonus routing happens via bonusSceneIdFor).
TimeWindow? _windowFromSceneId(String id) {
  if (id.startsWith('sabah')) return TimeWindow.sabah;
  if (id.startsWith('oglen')) return TimeWindow.oglen;
  if (id.startsWith('ikindi')) return TimeWindow.ikindi;
  if (id.startsWith('aksam')) return TimeWindow.aksam;
  return null;
}

/// Safer wrapper around [game2TypeFromId] that accepts null and
/// unknown values without throwing. Keeps the Isar query code tidy.
Game2Type? game2TypeFromIdSafe(String id) => switch (id) {
      'plate_matching' => Game2Type.plateMatching,
      'sequence_ordering' => Game2Type.sequenceOrdering,
      'quantity_counting' => Game2Type.quantityCounting,
      'next_step_planning' => Game2Type.nextStepPlanning,
      _ => null,
    };

/// v2 — returns the bonus scene id to offer after a session, or null
/// if no offer should appear right now. Policy:
///
///   * The scene must declare a bonusSceneId.
///   * The patient must have at least one completed session in this
///     time window today (i.e., this is the 2nd+ entry).
///   * The bonus for this window must not have already been played
///     today.
String? shouldOfferBonus({
  required Scene scene,
  required TimeWindow window,
  required TodaySessionSnapshot today,
}) {
  final bonusId = scene.bonusSceneId;
  if (bonusId == null) return null;
  final completed = today.completedByWindow[window] ?? 0;
  if (completed < 1) return null;
  if (today.bonusPlayedByWindow[window] == true) return null;
  return bonusId;
}

/// Item-combo rotation — scheduler-side knowledge that item rotation
/// is the scheduler's responsibility. The hash itself is produced by
/// [GameSessionController] at flush time (sceneId + sorted correct
/// itemIds). The scheduler uses [hasRecentCombo] to avoid assigning a
/// combo that was seen in the last 3 days.
Future<bool> hasRecentCombo({
  required Isar isar,
  required String profileId,
  required String comboHash,
  required DateTime now,
}) async {
  final threshold = now.subtract(const Duration(days: 3));
  final recent = await isar.sessionLogs
      .filter()
      .profileIdEqualTo(profileId)
      .startedAtGreaterThan(threshold)
      .findAll();
  for (final s in recent) {
    if (s.itemComboHash == comboHash) return true;
  }
  return false;
}
