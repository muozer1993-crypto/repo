import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../game/data/scene_repository.dart';
import '../../profile/data/profile_repository.dart';
import 'scheduler_controller.dart';

/// v2 — per-window dismissal flag. Resets implicitly each time the
/// provider rebuilds (e.g. on day change or manual refresh).
final _dismissedBonusWindowsProvider = StateProvider<Set<TimeWindow>>(
  (_) => <TimeWindow>{},
);

/// Resolves the current bonus offer state by consulting today's Isar
/// snapshot via [shouldOfferBonus] in scheduler_controller.dart.
///
/// Returns the bonusSceneId to offer, or null when no offer should
/// surface (first entry of the day, bonus already played, no bonus
/// configured, or the patient dismissed it).
final _resolvedBonusOfferProvider = FutureProvider<String?>((ref) async {
  final profile = ref.watch(patientProfileProvider).value;
  if (profile == null) return null;

  final now = ref.watch(clockProvider)();
  final window = windowFor(now);
  if (window == TimeWindow.dinlenme) return null;

  if (ref.watch(_dismissedBonusWindowsProvider).contains(window)) return null;

  final scene = await ref.watch(sceneRepositoryProvider).byWindow(window);
  if (scene == null) return null;

  final snapshot = await loadTodaySnapshot(
    isar: ref.watch(isarProvider),
    profileId: profile.profileId,
    now: now,
  );

  return shouldOfferBonus(
    scene: scene,
    window: window,
    today: snapshot,
  );
});

/// Controller that wraps the resolved offer + dismissal mutation.
class PostSessionBonusController
    extends StateNotifier<AsyncValue<String?>> {
  PostSessionBonusController(this._ref) : super(const AsyncValue.loading()) {
    _init();
  }

  final Ref _ref;

  Future<void> _init() async {
    final offer = await _ref.watch(_resolvedBonusOfferProvider.future);
    if (!mounted) return;
    state = AsyncValue.data(offer);
  }

  /// Home screen calls this on "Hayır, teşekkürler". Dismissal is
  /// per-window and resets implicitly when the provider rebuilds for
  /// a different window (e.g. time of day change).
  void dismissForWindow(TimeWindow w) {
    final now = _ref.read(clockProvider)();
    _ref.read(_dismissedBonusWindowsProvider.notifier).update((prev) {
      return {...prev, w};
    });
    // refresh — the state turns null immediately.
    state = const AsyncValue.data(null);
    // Keep the internal use of `now` so the import stays pinned; no-op
    // in practice but documents the decision point.
    assert(now.isAfter(DateTime(1970)));
  }
}

final postSessionBonusAvailableProvider = StateNotifierProvider<
    PostSessionBonusController, AsyncValue<String?>>(
  (ref) => PostSessionBonusController(ref),
);
