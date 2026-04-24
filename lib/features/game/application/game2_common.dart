import 'package:flutter/foundation.dart';

import '../../progress/domain/session_log.dart';
import '../domain/scene.dart';

/// v2 — shared types across the four Game-2 variants.
///
/// Each concrete Game-2 widget maintains its own state but surfaces
/// completion via [Game2Result] so the parent [GameSessionController]
/// can merge Game-1 + Game-2 metrics into a single [SessionLog] row.

/// Result of a single tap in a Game-2 variant. Used to drive the same
/// errorless feedback pattern as Game-1 (correct = glow + audio,
/// wrong = silent wobble, no red).
enum Game2Outcome { correct, wrong }

/// Everything a Game-2 controller needs to emit [PlacementEvent]s with
/// the revision #5 context baked in, and to roll up a [Game2Result]
/// when the play finishes.
@immutable
class Game2Deps {
  const Game2Deps({
    required this.config,
    required this.scene,
    required this.variant,
    required this.clock,
    required this.profileId,
    required this.sessionId,
  });

  final Game2Config config;
  final Scene scene;
  final DifficultyVariant variant;
  final DateTime Function() clock;
  final String profileId;
  final String sessionId;
}

/// What each Game-2 widget returns to the parent session controller
/// when it completes or is exited early. Placements are *not* flushed
/// directly by the Game-2 widget — the session controller batches
/// Game-1 + Game-2 placements into a single Isar transaction at the
/// end of the session.
@immutable
class Game2Result {
  const Game2Result({
    required this.type,
    required this.errorCount,
    required this.completed,
    required this.placements,
  });

  final Game2Type type;
  final int errorCount;
  final bool completed;
  final List<PlacementEvent> placements;

  Game2Result copyWith({
    int? errorCount,
    bool? completed,
    List<PlacementEvent>? placements,
  }) {
    return Game2Result(
      type: type,
      errorCount: errorCount ?? this.errorCount,
      completed: completed ?? this.completed,
      placements: placements ?? this.placements,
    );
  }

  static Game2Result empty(Game2Type type) => Game2Result(
        type: type,
        errorCount: 0,
        completed: false,
        placements: const [],
      );
}

/// Build a PlacementEvent for a Game-2 tap. Mirrors the Game-1 context
/// fields so the weekly report can union-aggregate across games.
PlacementEvent buildGame2PlacementEvent({
  required Game2Deps deps,
  required String itemId,
  required String targetSlotId,
  required Game2Outcome outcome,
  required bool tappedDistractor,
  required DateTime sessionStart,
  required DateTime? lastTapAt,
  required DateTime now,
  required int itemCountOnScreen,
}) {
  final reactionMs = now.difference(sessionStart).inMilliseconds;
  final waitMs = lastTapAt == null
      ? reactionMs
      : now.difference(lastTapAt).inMilliseconds;
  return PlacementEvent()
    ..sessionId = deps.sessionId
    ..profileId = deps.profileId
    ..itemId = itemId
    ..targetSlotId = targetSlotId
    ..correct = outcome == Game2Outcome.correct
    ..tappedDistractor = tappedDistractor
    ..reactionTimeMs = reactionMs
    ..waitTimeMs = waitMs
    ..at = now
    ..itemCountAtScene = itemCountOnScreen
    ..distractorCategory = distractorCategoryId(deps.variant.distractorMode)
    ..sequenceRequired = deps.variant.sequenceRequired
    ..difficultyLevel = deps.variant.level
    ..gameType = 'game2';
}
