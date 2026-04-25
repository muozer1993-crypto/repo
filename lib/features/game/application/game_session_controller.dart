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
import 'game2_common.dart';
import 'scene_controller.dart';

/// v2 — lifecycle phase for a single scene attempt.
///
/// A scene attempt now covers up to three plays:
///   orientation → game1 → (optional) game2 → (optional) bonus
/// GameSessionController advances through these and owns the single
/// [SessionLog] row that will capture g1 + g2 metrics.
///
/// [farewell] is the early-stop terminal: rendered when the patient
/// hits Çık during a phase or "Şimdilik yeterli" on the transition
/// screen. Shows a "Görüşürüz" message + Çık button (not the celebratory
/// CompletionOverlay) and exits the app.
enum GameSessionPhase {
  orientation,
  game1,
  transitionToGame2,
  game2,
  completed,
  bonusOffer,
  bonus,
  farewell,
  done,
}

/// UI-facing snapshot held by [GameSessionController].
@immutable
class GameSessionState {
  const GameSessionState({
    required this.phase,
    required this.scene,
    required this.variant,
    required this.scheduleEntry,
    required this.sessionId,
    required this.startedAt,
    this.game1Errors = 0,
    this.game1Completed = false,
    this.game2Errors = 0,
    this.game2Completed = false,
    this.bonusStartedAt,
    this.bonusSceneId,
    this.offerBonus = false,
  });

  final GameSessionPhase phase;
  final Scene scene;
  final DifficultyVariant variant;
  final ScheduleEntry scheduleEntry;
  final String sessionId;
  final DateTime startedAt;

  final int game1Errors;
  final bool game1Completed;
  final int game2Errors;
  final bool game2Completed;

  /// Set when the session controller decides to offer a post-session
  /// bonus (e.g. "this is the patient's 2nd entry into this window
  /// and the scene has a bonusSceneId").
  final bool offerBonus;

  /// Set once the patient accepts the bonus and it actually starts.
  final DateTime? bonusStartedAt;
  final String? bonusSceneId;

  int get totalErrors => game1Errors + game2Errors;

  GameSessionState copyWith({
    GameSessionPhase? phase,
    int? game1Errors,
    bool? game1Completed,
    int? game2Errors,
    bool? game2Completed,
    bool? offerBonus,
    DateTime? bonusStartedAt,
    String? bonusSceneId,
  }) {
    return GameSessionState(
      phase: phase ?? this.phase,
      scene: scene,
      variant: variant,
      scheduleEntry: scheduleEntry,
      sessionId: sessionId,
      startedAt: startedAt,
      game1Errors: game1Errors ?? this.game1Errors,
      game1Completed: game1Completed ?? this.game1Completed,
      game2Errors: game2Errors ?? this.game2Errors,
      game2Completed: game2Completed ?? this.game2Completed,
      offerBonus: offerBonus ?? this.offerBonus,
      bonusStartedAt: bonusStartedAt ?? this.bonusStartedAt,
      bonusSceneId: bonusSceneId ?? this.bonusSceneId,
    );
  }
}

/// Coordinates the full session lifecycle: orientation → game1 →
/// (optional) game2 → completion → (optional) bonus offer.
///
/// The controller does *not* render anything; it owns state and
/// persistence. The view layer (scene_player_screen + game2 widgets +
/// bonus widgets) reads [GameSessionState.phase] and mounts the
/// appropriate sub-view.
class GameSessionController extends StateNotifier<GameSessionState> {
  GameSessionController({
    required SceneArgs args,
    required this.isar,
    required this.clock,
    required this.profileId,
    this.offerBonusDecision,
  }) : super(
          GameSessionState(
            phase: GameSessionPhase.orientation,
            scene: args.scene,
            variant: args.variant,
            scheduleEntry: args.scheduleEntry,
            sessionId: const Uuid().v4(),
            startedAt: clock(),
          ),
        );

  final dynamic isar; // Isar — kept dynamic for test fakes.
  final DateTime Function() clock;
  final String profileId;

  /// Optional pluggable policy for "should we offer bonus after this
  /// session?". Defaults to: offer if scene has a bonusSceneId AND the
  /// session completed both games without catastrophic errors. The
  /// scheduler will override this with the "2nd entry into window"
  /// rule in Faz D.
  final bool Function(GameSessionState)? offerBonusDecision;

  // ----- Orientation card -----

  bool? _orientationCorrect;
  int? _orientationResponseMs;
  int _instructionReplayCount = 0;

  void onOrientationAnswered({required bool correct, required int responseMs}) {
    _orientationCorrect = correct;
    _orientationResponseMs = responseMs;
    state = state.copyWith(phase: GameSessionPhase.game1);
  }

  void onInstructionReplayed() {
    _instructionReplayCount += 1;
  }

  // ----- Game-1 hand-off -----

  final List<PlacementEvent> _game1Placements = [];

  /// Called by SceneController (via a wiring callback) every time it
  /// records a PlacementEvent for Game-1. We batch them here so they
  /// land in the same transaction as Game-2's placements.
  void recordGame1Placement(PlacementEvent ev) {
    ev.gameType = 'game1';
    _game1Placements.add(ev);
  }

  void onGame1Completed({required int errorCount, required bool completed}) {
    state = state.copyWith(
      game1Errors: errorCount,
      game1Completed: completed,
    );
    // v2 — if the scene has a Game-2, advance to the transition; if
    // not, finish the session immediately and route to farewell. The
    // intermediate "completed" phase + CompletionOverlay is gone — its
    // "Ana ekrana dön" button confused patients who'd just been told
    // "şimdilik yeterli" minutes earlier and saw the same destination.
    if (state.scene.game2 == null) {
      // ignore: discarded_futures
      _completeAndFareWell();
    } else {
      state = state.copyWith(phase: GameSessionPhase.transitionToGame2);
    }
  }

  /// v2 — record Game-1 stats WITHOUT transitioning to the next phase.
  /// Used by the Çık-during-game-1 path which doesn't want a transient
  /// TransitionScreen rendered between flush and the hard-exit, and by
  /// the orientation-phase Çık (where game1 hasn't even started).
  void recordGame1StatsNoTransition({
    required int errorCount,
    required bool completed,
  }) {
    state = state.copyWith(
      game1Errors: errorCount,
      game1Completed: completed,
    );
  }

  // ----- Transition -----

  /// Called by the patient tapping "Devam" on the TransitionScreen.
  void onTransitionContinue() {
    if (state.phase != GameSessionPhase.transitionToGame2) return;
    if (state.scene.game2 == null) {
      // Defensive — TransitionScreen shouldn't have been mounted on a
      // game2-less scene anyway. Funnel through the same farewell
      // path the rest of the controller uses.
      // ignore: discarded_futures
      _completeAndFareWell();
      return;
    }
    state = state.copyWith(phase: GameSessionPhase.game2);
  }

  /// Called by the patient skipping Game-2 on the TransitionScreen
  /// (e.g. tired, caregiver wants to finish). Marks game2 as not
  /// completed and routes to the farewell phase, NOT the celebratory
  /// completion screen — the patient explicitly chose to stop.
  Future<void> onTransitionSkipGame2() async {
    state = state.copyWith(
      game2Completed: false,
      phase: GameSessionPhase.farewell,
    );
    // Persist what we have so far. _writeAll catches its own errors so
    // the UI advances even if the device is offline.
    await _flushSessionRow(exitedEarly: true);
  }

  /// v2 — fired when the patient hits Çık in any active phase. Flushes
  /// what's been captured so far and routes to the farewell screen so
  /// the patient sees a goodbye + an actual Çık button before leaving.
  Future<void> exitToFarewell() async {
    state = state.copyWith(phase: GameSessionPhase.farewell);
    await _flushSessionRow(exitedEarly: true);
  }

  // ----- Game-2 -----

  List<PlacementEvent> _game2Placements = [];
  Game2Type? _game2Type;

  void onGame2Result(Game2Result result) {
    _game2Placements = List.of(result.placements);
    _game2Type = result.type;
    state = state.copyWith(
      game2Errors: result.errorCount,
      game2Completed: result.completed,
    );
    // ignore: discarded_futures
    _completeAndFareWell();
  }

  /// Internal: flush the session row, mark the celebration flag, and
  /// transition to farewell. Single funnel for both successful Game-1
  /// (no-game2 scenes) and Game-2 completion.
  Future<void> _completeAndFareWell() async {
    await _flushSessionRow(exitedEarly: false);
    state = state.copyWith(phase: GameSessionPhase.farewell);
  }

  // ----- Completion / bonus offer -----

  /// Flush the session row + placements + schedule entry in a single
  /// Isar transaction, then decide whether to offer the bonus.
  ///
  /// Critical invariant: the state.copyWith at the end ALWAYS runs
  /// even if the Isar write throws. Earlier code skipped the state
  /// update on flush failure, which left the UI stuck on the
  /// completion screen with a non-functional "Ana ekrana dön" button.
  Future<void> finishAndFlush({required bool exitedEarly}) async {
    await _flushSessionRow(exitedEarly: exitedEarly);

    // v2 policy: in-session bonus offer is OFF by default. The home
    // screen's _PostSessionBonusOffer is the single surface for the
    // 2nd-entry-of-the-day bonus invitation, so completion always
    // routes home and the home screen decides whether to surface
    // BonusOfferTile based on Today's snapshot. This makes the
    // CompletionOverlay's "Ana ekrana dön" button do exactly what it
    // says — go home — instead of pivoting to a bonus offer screen.
    final shouldOffer = !exitedEarly &&
        state.scene.bonusSceneId != null &&
        state.game1Completed &&
        (offerBonusDecision != null && offerBonusDecision!(state));
    state = state.copyWith(
      phase: shouldOffer
          ? GameSessionPhase.bonusOffer
          : GameSessionPhase.done,
      offerBonus: shouldOffer,
      bonusSceneId: state.scene.bonusSceneId,
    );
  }

  /// Build the session row + placements + schedule entry and try to
  /// persist them in one writeTxn. Returns whether the write
  /// succeeded — but callers shouldn't gate UI advancement on it.
  Future<bool> _flushSessionRow({required bool exitedEarly}) async {
    final now = clock();
    final totalErrors = state.totalErrors;
    final updatedEntry = onCompletion(
      state.scheduleEntry,
      errorCount: totalErrors,
      now: now,
    );

    final log = SessionLog()
      ..sessionId = state.sessionId
      ..profileId = profileId
      ..sceneId = state.scene.id
      ..startedAt = state.startedAt
      ..finishedAt = now
      ..errorCount = totalErrors
      ..completed = !exitedEarly &&
          state.game1Completed &&
          (state.scene.game2 == null || state.game2Completed)
      ..srIntervalAtStart = state.scheduleEntry.srInterval
      ..srIntervalAtEnd = updatedEntry.srInterval
      ..difficultyAtStart = state.scheduleEntry.difficultyLevel
      ..difficultyAtEnd = updatedEntry.difficultyLevel
      ..orientationCorrect = _orientationCorrect
      ..orientationResponseMs = _orientationResponseMs
      ..instructionReplayCount = _instructionReplayCount
      ..appOpenCountOnThatDay = 0
      ..game1ErrorCount = state.game1Errors
      ..game1Completed = state.game1Completed
      ..game2ErrorCount = state.game2Errors
      ..game2Completed = state.game2Completed
      ..game2Type = _game2Type == null ? null : game2TypeId(_game2Type!)
      ..itemComboHash = _buildItemComboHash();

    try {
      await _writeAll(log, updatedEntry);
      return true;
    } catch (e, st) {
      // Don't crash the UI; the row stays in Isar with syncedAt=null
      // for next launch. Log to console so devs see the cause.
      // ignore: avoid_print
      print('finishAndFlush write failed (continuing): $e\n$st');
      return false;
    }
  }

  /// Hash of the sceneId + sorted item ids seen in Game-1. Used by
  /// the scheduler's "no-repeat-combo-in-last-3-days" rule. Returns
  /// null if the session ran too briefly to produce meaningful items.
  String? _buildItemComboHash() {
    if (_game1Placements.isEmpty) return null;
    final ids = _game1Placements
        .where((p) => p.correct)
        .map((p) => p.itemId)
        .toSet()
        .toList()
      ..sort();
    if (ids.isEmpty) return null;
    return '${state.scene.id}:${ids.join(",")}';
  }

  Future<void> _writeAll(SessionLog log, ScheduleEntry entry) async {
    final allPlacements = [..._game1Placements, ..._game2Placements];
    // ignore: avoid_dynamic_calls
    await isar.writeTxn(() async {
      // ignore: avoid_dynamic_calls
      await isar.sessionLogs.put(log);
      // ignore: avoid_dynamic_calls
      await isar.placementEvents.putAll(allPlacements);
      // ignore: avoid_dynamic_calls
      await isar.scheduleEntries.put(entry);
    });
  }

  // ----- Bonus flow -----

  void onBonusAccepted() {
    if (!state.offerBonus || state.bonusSceneId == null) return;
    state = state.copyWith(
      phase: GameSessionPhase.bonus,
      bonusStartedAt: clock(),
    );
  }

  void onBonusDeclined() {
    state = state.copyWith(
      phase: GameSessionPhase.done,
      offerBonus: false,
    );
  }

  void onBonusFinished() {
    state = state.copyWith(phase: GameSessionPhase.done);
  }
}

/// Provider for the current session. Auto-disposes when the session
/// screen is popped — a fresh session starts a fresh controller.
final gameSessionControllerProvider = StateNotifierProvider.autoDispose<
    GameSessionController, GameSessionState>((ref) {
  final args = ref.watch(sceneArgsProvider);
  if (args == null) {
    throw StateError('sceneArgsProvider must be set before the session '
        'screen is mounted.');
  }
  final profile = ref.watch(patientProfileProvider).value;
  if (profile == null) {
    throw StateError('PatientProfile must exist before a session starts.');
  }
  return GameSessionController(
    args: args,
    isar: ref.watch(isarProvider),
    clock: ref.watch(clockProvider),
    profileId: profile.profileId,
  );
});
