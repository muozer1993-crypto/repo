import 'package:flutter/foundation.dart';

import '../../../domain/scene.dart';

/// v2 — shared state every bonus widget reports back to its parent.
///
/// Bonus plays do not track errorCount (errorless is the whole point
/// of bonus plays — it's supposed to feel like nothing can go wrong),
/// so all we need to surface is: did the patient engage, how many
/// taps did they make, and when did it end.
@immutable
class BonusPlayResult {
  const BonusPlayResult({
    required this.bonusSceneId,
    required this.bonusType,
    required this.tapCount,
    required this.finishedAt,
  });

  final String bonusSceneId;
  final BonusType bonusType;
  final int tapCount;

  /// Null if the patient exited before the bonus reached a natural
  /// end. Widgets that have no natural end (free_explore) pass null;
  /// widgets with a completion goal (find_item, tap_sequence,
  /// pair_match) pass the finish time.
  final DateTime? finishedAt;
}

/// Callback type every bonus widget expects from its host.
typedef BonusPlayResultCallback = void Function(BonusPlayResult result);
