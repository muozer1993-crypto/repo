import 'package:isar/isar.dart';

part 'session_log.g.dart';

/// v2 — which game produced this row. Stored as a string in the Isar
/// schema (`gameType` on [PlacementEvent], `game2Type` on [SessionLog])
/// so Supabase column values match without extra mapping. This enum is
/// the canonical Dart-side vocabulary; conversions live in
/// [gameTypeId] / [gameTypeFromId].
enum GameType { game1, game2, bonus }

String gameTypeId(GameType g) => switch (g) {
      GameType.game1 => 'game1',
      GameType.game2 => 'game2',
      GameType.bonus => 'bonus',
    };

GameType? gameTypeFromId(String? id) => switch (id) {
      'game1' => GameType.game1,
      'game2' => GameType.game2,
      'bonus' => GameType.bonus,
      _ => null,
    };

/// One row per scene attempt.
///
/// Every field the weekly therapist report will eventually read is
/// recorded at session end. Orientation-card response and instruction
/// replay count (clinical revisions #4 and #6) are stored as null-able
/// so that sessions which skip either path remain valid.
///
/// v2 — a single session now covers Game-1 + Game-2 (same scene, same
/// time window). The [game1*] and [game2*] mirrors record per-game
/// completion separately; the top-level [errorCount] / [completed]
/// fields stay as the session-wide total (Game-1 + Game-2) so existing
/// v1 report code keeps working.
@collection
class SessionLog {
  Id id = Isar.autoIncrement;

  /// Server-side uuid. Generated when the session starts so we can
  /// reference it from [PlacementEvent] rows before they are synced.
  @Index(unique: true)
  late String sessionId;

  /// [PatientProfile.profileId].
  late String profileId;

  @Index()
  late String sceneId;

  @Index()
  late DateTime startedAt;

  DateTime? finishedAt;

  late int errorCount;
  late bool completed;

  // v2 — per-game split. Both default to 0/false so pre-v2 rows
  // migrated from the old schema stay queryable.
  int game1ErrorCount = 0;
  bool game1Completed = false;
  int game2ErrorCount = 0;
  bool game2Completed = false;

  /// v2 — which Game-2 type was served in this session. Null if the
  /// session was Game-1 only (learning phase bypass) or if the scene
  /// doesn't declare a game2 config. Stored as its string id for
  /// forward-compat with the Supabase text column.
  String? game2Type;

  /// v2 — rotation hash "sceneId:sortedItemIds". The scheduler uses it
  /// to reject a combo that appeared in the last 3 days so the first-3-
  /// days learning phase never repeats an item set.
  String? itemComboHash;

  // Clinical revision #2: srInterval and difficultyLevel are orthogonal.
  // We snapshot both at session start and end so regressions are visible
  // in reports even for sessions that straddle stage transitions.
  late int srIntervalAtStart;
  late int srIntervalAtEnd;
  late int difficultyAtStart;
  late int difficultyAtEnd;

  /// Clinical revision #4 — time-orientation card result.
  /// Null when the card was skipped (should never happen in v1 but
  /// keeps the schema forward-compatible).
  bool? orientationCorrect;
  int? orientationResponseMs;

  /// Clinical revision #6 — how many times the patient asked to hear
  /// the instruction audio again. A high replay count flags working-
  /// memory strain to the therapist.
  int instructionReplayCount = 0;

  /// How many times the app was opened on this calendar day before the
  /// session started. Helps the therapist spot patients who open and
  /// close the app repeatedly without playing.
  int appOpenCountOnThatDay = 0;

  /// Null until the row is upserted to Supabase.
  DateTime? syncedAt;
}

/// One row per tap attempt.
///
/// We record EVERY tap, not just successful placements — including
/// distractor taps and wrong-sequence taps. The context fields
/// (itemCountAtScene, distractorCategory, sequenceRequired,
/// difficultyLevel) are clinical revision #5 and let the therapist see
/// WHICH axis performance regressed on, not just "error count is up".
@collection
class PlacementEvent {
  Id id = Isar.autoIncrement;

  @Index()
  late String sessionId;

  late String profileId;

  late String itemId;

  /// Tap target — if the patient tapped a distractor in the tray we
  /// still record the "nearest intended slot" (null-coalesced to empty).
  late String targetSlotId;

  late bool correct;

  /// Clinical revision #3 — did the patient tap a distractor item?
  late bool tappedDistractor;

  /// Milliseconds from scene/variant render to this tap.
  late int reactionTimeMs;

  /// Milliseconds from the previous tap to this tap.
  late int waitTimeMs;

  late DateTime at;

  // Clinical revision #5 — context baked into each event.

  /// Total item count in the tray when this tap happened (includes
  /// distractors). Lets reports normalize error rates.
  late int itemCountAtScene;

  /// 'absent' | 'far' | 'near' | 'functional'. Stored as a string to
  /// match the Supabase text column and keep Isar schema independent
  /// from the UI-domain `DistractorCategory` enum.
  late String distractorCategory;

  late bool sequenceRequired;
  late int difficultyLevel;

  /// v2 — which game produced this tap. 'game1' for v1-compatible
  /// errorless placements; 'game2' for the second-game variants
  /// (plate_matching / sequence_ordering / quantity_counting /
  /// next_step_planning). Bonus plays do not emit PlacementEvent —
  /// they write [BonusPlayEvent] instead.
  ///
  /// Defaults to 'game1' so pre-v2 rows stay valid without migration.
  String gameType = 'game1';

  DateTime? syncedAt;
}
