import 'package:isar/isar.dart';

part 'missed_slot_event.g.dart';

/// v2 — one row per time-window that closed without the patient
/// starting the scheduled scene. The scheduler writes these lazily:
/// when [SchedulerController] loads and detects that a previous
/// window (sabah/oglen/ikindi/aksam) ended with no SessionLog row for
/// that window on that calendar day, it emits a MissedSlotEvent.
///
/// Used by the weekly report to build the "dilim kaçırma haritası"
/// (missed-slot heat map) and by the scheduler to decide whether a
/// patient's cleanRunStreak should reset.
@collection
class MissedSlotEvent {
  Id id = Isar.autoIncrement;

  @Index()
  late String profileId;

  /// 'sabah' | 'oglen' | 'ikindi' | 'aksam'. Night window never emits
  /// a missed-slot event — no main scene is scheduled during dinlenme.
  late String timeWindow;

  /// The scene that *would* have been played had the patient opened
  /// the app in time. Lets the therapist see "she keeps skipping the
  /// lunch scene specifically" rather than "she keeps missing 11–15".
  late String sceneId;

  /// The calendar date of the missed window. Stored as a DateTime at
  /// 00:00 so queries like "days-missed this week" can group cleanly.
  @Index()
  late DateTime missedOn;

  /// When the detection ran — i.e. when the scheduler noticed the
  /// window had closed. Useful for distinguishing "missed on Monday,
  /// noticed Tuesday morning" from "missed on Monday, app opened
  /// Monday evening past the window".
  late DateTime detectedAt;

  DateTime? syncedAt;
}
