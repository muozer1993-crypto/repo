import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../game/application/scene_controller.dart';
import '../../game/data/scene_repository.dart';
import '../../game/domain/scene.dart';
import '../data/schedule_repository.dart';
import '../domain/schedule_entry.dart';

/// What the home screen shows "Başla" for, plus the args the scene
/// player needs when launched.
class LaunchPlan {
  LaunchPlan({
    required this.window,
    required this.scene,
    required this.variant,
    required this.scheduleEntry,
  });

  final TimeWindow window;
  final Scene scene;
  final DifficultyVariant variant;
  final ScheduleEntry scheduleEntry;

  SceneArgs toArgs() => SceneArgs(
        scene: scene,
        variant: variant,
        scheduleEntry: scheduleEntry,
      );
}

/// Builds the [LaunchPlan] for the current moment.
///
/// Responsibilities:
///   * Compute the current [TimeWindow] via the injected clock.
///   * Look up (or create) the matching scene's [ScheduleEntry].
///   * Pick the scene variant indexed by [ScheduleEntry.difficultyLevel].
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
  final variant = scene.variantFor(entry.difficultyLevel);
  return LaunchPlan(
    window: window,
    scene: scene,
    variant: variant,
    scheduleEntry: entry,
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
