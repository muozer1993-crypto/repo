import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Thin wrapper around [HapticFeedback] so we can stub it in tests.
///
/// All feedback levels stay at `lightImpact` / `selectionClick` — no
/// heavy impacts or alert patterns, because stronger haptics can
/// startle frail patients.
class HapticsService {
  const HapticsService();

  Future<void> light() => HapticFeedback.lightImpact();

  Future<void> selection() => HapticFeedback.selectionClick();
}

final hapticsServiceProvider =
    Provider<HapticsService>((_) => const HapticsService());
