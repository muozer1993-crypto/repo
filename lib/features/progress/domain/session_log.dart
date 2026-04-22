import 'package:isar/isar.dart';

part 'session_log.g.dart';

/// One row per scene attempt.
///
/// Every field the weekly therapist report will eventually read is
/// recorded at session end. Orientation-card response and instruction
/// replay count (clinical revisions #4 and #6) are stored as null-able
/// so that sessions which skip either path remain valid.
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

  DateTime? syncedAt;
}
