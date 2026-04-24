import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/time/time_window.dart';

/// v2 — per-window "dismiss this bonus offer" flag. Resets at
/// midnight implicitly (provider is rebuilt when the home screen
/// reloads, and the flag is a plain Set).
///
/// Faz D will wire the "should we offer the bonus right now?" query
/// against today's SessionLog + BonusPlayEvent rows in Isar. Until
/// then [postSessionBonusAvailableProvider] yields null so the home
/// screen never renders the post-session offer — the scaffolding is
/// in place, just gated off.
class PostSessionBonusController
    extends StateNotifier<AsyncValue<String?>> {
  PostSessionBonusController() : super(const AsyncValue.data(null));

  final Set<TimeWindow> _dismissed = {};

  /// Called by the home screen's "Hayır, teşekkürler" button — hides
  /// the offer for the current window until the window rolls over.
  void dismissForWindow(TimeWindow w) {
    _dismissed.add(w);
    state = const AsyncValue.data(null);
  }

  /// Call when the scheduler detects the offer should surface for the
  /// given window + scene. Noop in v2 bootstrap; Faz D populates it.
  // ignore: unused_element
  void _offerFor(TimeWindow w, String bonusSceneId) {
    if (_dismissed.contains(w)) return;
    state = AsyncValue.data(bonusSceneId);
  }
}

final postSessionBonusAvailableProvider = StateNotifierProvider<
    PostSessionBonusController, AsyncValue<String?>>(
  (_) => PostSessionBonusController(),
);
