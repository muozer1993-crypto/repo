import 'package:isar/isar.dart';

part 'bonus_play_event.g.dart';

/// v2 — a bonus play session. Bonus plays are the "rahatlatıcı" flows
/// offered after a successful dilim or at night; they have no error
/// counter, no timer, and no spaced-retrieval side-effects. The only
/// metrics the therapist report cares about are: did the patient
/// engage (finishedAt != null)?, how long did they linger (tapCount,
/// duration), and which bonus type was served.
///
/// Kept as its own collection rather than a subtype of SessionLog so
/// the v1 report code that aggregates SessionLog rows does not
/// accidentally include bonus minutes in "active play time" metrics.
@collection
class BonusPlayEvent {
  Id id = Isar.autoIncrement;

  @Index(unique: true)
  late String bonusPlayId;

  /// [PatientProfile.profileId].
  @Index()
  late String profileId;

  /// [BonusScene.id].
  late String bonusSceneId;

  /// 'find_item' | 'tap_sequence' | 'pair_match' | 'free_explore'.
  /// Stored as the canonical string id (bonusTypeId) so the Supabase
  /// text column can be queried directly.
  late String bonusType;

  @Index()
  late DateTime startedAt;

  /// Null if the patient exited before the bonus naturally ended;
  /// bonus plays do not enforce completion so this often stays null
  /// for free_explore — that's fine, the therapist report only checks
  /// engagement presence.
  DateTime? finishedAt;

  /// Cumulative tap count during the play. For free_explore this is
  /// "times the patient engaged with an object"; for tap_sequence
  /// it's total taps including out-of-order ones.
  int tapCount = 0;

  /// True if the bonus played during the 23:00–06:00 night window.
  /// Night bonuses have no "offer after success" prerequisite; they
  /// are always on the home screen during dinlenme.
  late bool nightBonus;

  /// Which time window the bonus played in. Stored even for night
  /// bonuses (where it is 'dinlenme') so the weekly report can split
  /// bonus engagement by slot.
  late String timeWindow;

  DateTime? syncedAt;
}
