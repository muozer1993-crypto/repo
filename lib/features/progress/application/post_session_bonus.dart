import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../game/data/scene_repository.dart';
import '../../profile/data/profile_repository.dart';
import 'scheduler_controller.dart';

/// v2 — set of windows the patient explicitly tapped "Hayır,
/// teşekkürler" on this app session. Resets on app restart so the
/// next day's offers come back even if the patient declined yesterday.
final _dismissedBonusWindowsProvider = StateProvider<Set<TimeWindow>>(
  (_) => <TimeWindow>{},
);

/// FutureProvider that resolves to the bonus scene id we should
/// surface on the home screen *right now*, or null if no offer is
/// appropriate.
///
/// Driven by [shouldOfferBonus] over today's Isar snapshot. Watching
/// [clockProvider] makes it auto-rebuild when test clocks tick; the
/// scene_player_screen explicitly invalidates this provider when
/// returning to home so a freshly-completed session immediately
/// surfaces its offer.
final postSessionBonusAvailableProvider =
    FutureProvider<String?>((ref) async {
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

/// Caregiver-facing "Hayır, teşekkürler" — adds the window to the
/// dismissal set and invalidates the resolver so the home screen
/// re-renders without the offer.
void dismissBonusForWindow(WidgetRef ref, TimeWindow w) {
  ref.read(_dismissedBonusWindowsProvider.notifier).update((prev) {
    return {...prev, w};
  });
  ref.invalidate(postSessionBonusAvailableProvider);
}
