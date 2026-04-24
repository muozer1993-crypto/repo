import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/time/clock_provider.dart';
import '../../profile/data/profile_repository.dart';
import '../../progress/application/spaced_retrieval.dart';
import '../../progress/domain/schedule_entry.dart';
import '../../progress/domain/session_log.dart';
import '../domain/scene.dart';
import 'game_session_controller.dart';

/// Parameters a scene is launched with. Scheduler controller builds
/// this and hands it to [SceneController] via [sceneArgsProvider].
@immutable
class SceneArgs {
  const SceneArgs({
    required this.scene,
    required this.variant,
    required this.scheduleEntry,
  });

  final Scene scene;
  final DifficultyVariant variant;
  final ScheduleEntry scheduleEntry;
}

/// Result of a single tap evaluation — consumed by the view layer to
/// animate the item (fly to slot on [TapOutcome.correct] or wobble on
/// the other two).
enum TapOutcome { correct, distractor, wrongSequence }

/// UI-facing snapshot.
@immutable
class SceneState {
  const SceneState({
    required this.scene,
    required this.variant,
    required this.placedItemIds,
    required this.errorCount,
    required this.instructionReplayCount,
    required this.hintTargetItemId,
    this.lastOutcome,
    this.lastOutcomeItemId,
    this.isComplete = false,
  });

  final Scene scene;
  final DifficultyVariant variant;
  final Set<String> placedItemIds;
  final int errorCount;
  final int instructionReplayCount;

  /// When non-null the view pulses this item's tile (revision: hint
  /// lives on the item tile, not on the slot — slots can't be tapped).
  final String? hintTargetItemId;

  /// Last tap result. Consumed by the view once and then cleared.
  final TapOutcome? lastOutcome;
  final String? lastOutcomeItemId;

  final bool isComplete;

  SceneState copyWith({
    Set<String>? placedItemIds,
    int? errorCount,
    int? instructionReplayCount,
    Object? hintTargetItemId = _sentinel,
    Object? lastOutcome = _sentinel,
    Object? lastOutcomeItemId = _sentinel,
    bool? isComplete,
  }) {
    return SceneState(
      scene: scene,
      variant: variant,
      placedItemIds: placedItemIds ?? this.placedItemIds,
      errorCount: errorCount ?? this.errorCount,
      instructionReplayCount:
          instructionReplayCount ?? this.instructionReplayCount,
      hintTargetItemId: identical(hintTargetItemId, _sentinel)
          ? this.hintTargetItemId
          : hintTargetItemId as String?,
      lastOutcome: identical(lastOutcome, _sentinel)
          ? this.lastOutcome
          : lastOutcome as TapOutcome?,
      lastOutcomeItemId: identical(lastOutcomeItemId, _sentinel)
          ? this.lastOutcomeItemId
          : lastOutcomeItemId as String?,
      isComplete: isComplete ?? this.isComplete,
    );
  }
}

const _sentinel = Object();

/// Threshold of inactivity after which the [SceneController] asks the
/// view to pulse the next-needed item tile.
const kHintThreshold = Duration(seconds: 8);

/// State machine for a single scene attempt.
///
/// Clinical rules live here (not in widgets) so they're testable:
///   * Distractor taps are errorless — the item bounces in place, no
///     ses/color/vibration.
///   * Sequence-required variants reject taps on the "correct" item
///     that's out of order.
///   * Every tap — correct, distractor, out-of-order — is recorded as
///     a PlacementEvent with the full revision #5 context.
class SceneController extends StateNotifier<SceneState> {
  SceneController({
    required SceneArgs args,
    required this.isar,
    required this.clock,
    required this.profileId,
    this.sessionId,
    this.deferWrite = false,
  })  : _scene = args.scene,
        _variant = args.variant,
        _scheduleEntry = args.scheduleEntry,
        _sessionId = sessionId ?? const Uuid().v4(),
        _sessionStart = clock(),
        super(
          SceneState(
            scene: args.scene,
            variant: args.variant,
            placedItemIds: const <String>{},
            errorCount: 0,
            instructionReplayCount: 0,
            hintTargetItemId: null,
          ),
        ) {
    _scheduleHint();
  }

  final Scene _scene;
  final DifficultyVariant _variant;
  final ScheduleEntry _scheduleEntry;
  final dynamic isar; // Isar — dynamic so tests can stub with fakes.
  final DateTime Function() clock;
  final String profileId;

  /// v2 — optional session id injected by GameSessionController so
  /// Game-1 placements share the same sessionId with Game-2 and the
  /// parent SessionLog row. When null (v1), a fresh uuid is generated.
  final String? sessionId;

  /// v2 — when true, [flushSession] no longer touches Isar; callers
  /// read [placements] + the state and persist via the parent
  /// GameSessionController instead.
  final bool deferWrite;

  final String _sessionId;
  final DateTime _sessionStart;
  final List<PlacementEvent> _pendingPlacements = [];
  DateTime? _lastTapAt;
  Timer? _hintTimer;

  // Orientation card metrics
  bool? _orientationCorrect;
  int? _orientationResponseMs;

  int get errorCount => state.errorCount;

  /// v2 — read-only access to the placements queued during Game-1.
  /// GameSessionController reads this on hand-off so the session
  /// writeTxn can include every tap in one transaction.
  List<PlacementEvent> get placements =>
      List.unmodifiable(_pendingPlacements);

  bool? get orientationCorrect => _orientationCorrect;
  int? get orientationResponseMs => _orientationResponseMs;
  DateTime get sessionStartedAt => _sessionStart;

  /// Handle a tap on [item].
  ///
  /// Returns the [TapOutcome] so the caller (the view) can trigger the
  /// right animation (fly-to-slot vs wobble).
  TapOutcome onTap(SceneItem item) {
    if (state.isComplete) return TapOutcome.correct; // ignore post-complete.
    if (state.placedItemIds.contains(item.id)) {
      return TapOutcome.correct; // already placed — ignore.
    }

    final now = clock();
    final reactionMs = now.difference(_sessionStart).inMilliseconds;
    final waitMs = _lastTapAt == null
        ? reactionMs
        : now.difference(_lastTapAt!).inMilliseconds;
    _lastTapAt = now;

    final outcome = _evaluate(item);

    _pendingPlacements.add(
      PlacementEvent()
        ..sessionId = _sessionId
        ..profileId = profileId
        ..itemId = item.id
        ..targetSlotId = item.acceptedSlotId ?? ''
        ..correct = outcome == TapOutcome.correct
        ..tappedDistractor = item.distractor
        ..reactionTimeMs = reactionMs
        ..waitTimeMs = waitMs
        ..at = now
        ..itemCountAtScene = _variant.items.length
        ..distractorCategory =
            distractorCategoryId(_variant.distractorMode)
        ..sequenceRequired = _variant.sequenceRequired
        ..difficultyLevel = _variant.level,
    );

    switch (outcome) {
      case TapOutcome.correct:
        final placed = {...state.placedItemIds, item.id};
        final done = placed.length == _variant.targetCount;
        state = state.copyWith(
          placedItemIds: placed,
          hintTargetItemId: null,
          lastOutcome: TapOutcome.correct,
          lastOutcomeItemId: item.id,
          isComplete: done,
        );
      case TapOutcome.distractor:
      case TapOutcome.wrongSequence:
        state = state.copyWith(
          errorCount: state.errorCount + 1,
          lastOutcome: outcome,
          lastOutcomeItemId: item.id,
        );
    }

    _scheduleHint();
    return outcome;
  }

  /// Called by the view once it has consumed the last outcome (played
  /// the animation).
  void clearLastOutcome() {
    state = state.copyWith(lastOutcome: null, lastOutcomeItemId: null);
  }

  TapOutcome _evaluate(SceneItem item) {
    if (item.distractor) return TapOutcome.distractor;
    if (!_variant.sequenceRequired) return TapOutcome.correct;

    // Sequence-required: only the next-unsatisfied sequenceOrder is
    // acceptable.
    final nextOrder = state.placedItemIds.length + 1;
    if (item.sequenceOrder == nextOrder) return TapOutcome.correct;
    return TapOutcome.wrongSequence;
  }

  void onInstructionReplayed() {
    state = state.copyWith(
      instructionReplayCount: state.instructionReplayCount + 1,
    );
  }

  void onOrientationAnswered({required bool correct, required int responseMs}) {
    _orientationCorrect = correct;
    _orientationResponseMs = responseMs;
  }

  void _scheduleHint() {
    _hintTimer?.cancel();
    if (state.isComplete) return;

    _hintTimer = Timer(kHintThreshold, () {
      // Next-needed target item.
      final next = _nextExpectedTarget();
      if (next == null) return;
      state = state.copyWith(hintTargetItemId: next.id);
    });
  }

  SceneItem? _nextExpectedTarget() {
    if (_variant.sequenceRequired) {
      final nextOrder = state.placedItemIds.length + 1;
      for (final it in _variant.items) {
        if (!it.distractor && it.sequenceOrder == nextOrder) return it;
      }
      return null;
    }
    for (final it in _variant.items) {
      if (it.distractor) continue;
      if (state.placedItemIds.contains(it.id)) continue;
      return it;
    }
    return null;
  }

  /// Persist the session to Isar + update the [ScheduleEntry] via the
  /// spaced-retrieval algorithm. Called when the scene completes OR
  /// when the scene is exited early (completed=false).
  ///
  /// v2 — when [deferWrite] is true this becomes a no-op; the parent
  /// GameSessionController is expected to call back after reading
  /// [placements] and state so it can batch Game-1 + Game-2 writes in
  /// a single transaction.
  Future<void> flushSession({required bool completed}) async {
    if (deferWrite) return;

    final now = clock();
    final updatedEntry = onCompletion(
      _scheduleEntry,
      errorCount: state.errorCount,
      now: now,
    );

    final log = SessionLog()
      ..sessionId = _sessionId
      ..profileId = profileId
      ..sceneId = _scene.id
      ..startedAt = _sessionStart
      ..finishedAt = now
      ..errorCount = state.errorCount
      ..completed = completed
      ..srIntervalAtStart = _scheduleEntry.srInterval
      ..srIntervalAtEnd = updatedEntry.srInterval
      ..difficultyAtStart = _scheduleEntry.difficultyLevel
      ..difficultyAtEnd = updatedEntry.difficultyLevel
      ..orientationCorrect = _orientationCorrect
      ..orientationResponseMs = _orientationResponseMs
      ..instructionReplayCount = state.instructionReplayCount
      ..appOpenCountOnThatDay = 0
      ..game1ErrorCount = state.errorCount
      ..game1Completed = completed;

    await _writeAll(log, updatedEntry);
  }

  Future<void> _writeAll(SessionLog log, ScheduleEntry entry) async {
    // ignore: avoid_dynamic_calls
    await isar.writeTxn(() async {
      // ignore: avoid_dynamic_calls
      await isar.sessionLogs.put(log);
      // ignore: avoid_dynamic_calls
      await isar.placementEvents.putAll(_pendingPlacements);
      // ignore: avoid_dynamic_calls
      await isar.scheduleEntries.put(entry);
    });
  }

  @override
  void dispose() {
    _hintTimer?.cancel();
    super.dispose();
  }
}

/// Args for the currently-launching scene. Set by the scheduler
/// controller before navigating to the scene player.
final sceneArgsProvider = StateProvider<SceneArgs?>((_) => null);

/// StateNotifier scoped to a single scene attempt. Auto-disposes when
/// the player screen is popped.
///
/// v2 — the player screen creates a [gameSessionControllerProvider]
/// first, and this provider pulls the shared sessionId from there so
/// Game-1 placements land on the same SessionLog row as Game-2. It
/// also flips deferWrite=true so flushes are batched by the parent.
final sceneControllerProvider =
    StateNotifierProvider.autoDispose<SceneController, SceneState>((ref) {
  final args = ref.watch(sceneArgsProvider);
  if (args == null) {
    throw StateError('sceneArgsProvider must be set before the player '
        'screen is mounted.');
  }
  final profile = ref.watch(patientProfileProvider).value;
  if (profile == null) {
    throw StateError('PatientProfile must exist before a scene starts.');
  }
  // Peek at the session (if any) without creating a hard dep cycle.
  // If the session provider has been instantiated by the player
  // screen, its sessionId is used; otherwise SceneController falls
  // back to its own uuid (v1 compat path for isolated tests).
  String? sharedSessionId;
  try {
    sharedSessionId = ref.read(gameSessionControllerProvider).sessionId;
  } catch (_) {
    sharedSessionId = null;
  }
  return SceneController(
    args: args,
    isar: ref.watch(isarProvider),
    clock: ref.watch(clockProvider),
    profileId: profile.profileId,
    sessionId: sharedSessionId,
    deferWrite: sharedSessionId != null,
  );
});
