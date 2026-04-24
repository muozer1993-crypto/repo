import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../game/data/scene_repository.dart';
import '../../profile/data/profile_repository.dart';
import '../domain/missed_slot_event.dart';
import '../domain/session_log.dart';

/// v2 — scans for time windows that closed today without a completed
/// SessionLog, and emits one [MissedSlotEvent] per missed slot. Runs
/// once at app open (from main.dart) after the patient profile has
/// loaded.
///
/// Invariants:
///   * Only writes for windows whose end time has already passed
///     at [now]. The current window is never flagged missed — the
///     patient still has time to play it.
///   * Dedupes via a (profileId, timeWindow, missedOn-date) key so
///     opening the app multiple times on the same day is idempotent.
///   * Skips dinlenme; no main-play scene is scheduled there.
class MissedSlotDetector {
  MissedSlotDetector({
    required this.isar,
    required this.sceneRepo,
    required this.clock,
  });

  final Isar isar;
  final SceneRepository sceneRepo;
  final DateTime Function() clock;

  Future<void> runFor({required String profileId}) async {
    final now = clock();
    final today = DateTime(now.year, now.month, now.day);
    final windowsToCheck = _pastWindowsToday(now);
    if (windowsToCheck.isEmpty) return;

    // Sessions played today for this profile.
    final todaySessions = await isar.sessionLogs
        .filter()
        .profileIdEqualTo(profileId)
        .startedAtGreaterThan(today)
        .findAll();

    // Already-recorded missed events for today, so we don't duplicate.
    final existingMisses = await isar.missedSlotEvents
        .filter()
        .profileIdEqualTo(profileId)
        .missedOnEqualTo(today)
        .findAll();
    final alreadyRecorded = {for (final m in existingMisses) m.timeWindow};

    final toWrite = <MissedSlotEvent>[];
    for (final w in windowsToCheck) {
      final wId = timeWindowId(w);
      if (alreadyRecorded.contains(wId)) continue;

      // A window is "played" if any SessionLog in it completed=true AND
      // the session's sceneId maps to that window.
      final scene = await sceneRepo.byWindow(w);
      if (scene == null) continue;

      final played = todaySessions.any(
        (s) => s.sceneId == scene.id && s.completed,
      );
      if (played) continue;

      toWrite.add(
        MissedSlotEvent()
          ..profileId = profileId
          ..timeWindow = wId
          ..sceneId = scene.id
          ..missedOn = today
          ..detectedAt = now,
      );
    }

    if (toWrite.isEmpty) return;
    await isar.writeTxn(() async {
      await isar.missedSlotEvents.putAll(toWrite);
    });
  }

  /// Returns the list of windows whose end-time is strictly before
  /// [now]. Current window + future windows are excluded.
  List<TimeWindow> _pastWindowsToday(DateTime now) {
    // Window boundaries (matching time_window.dart):
    //   sabah  06–11
    //   oglen  11–15
    //   ikindi 15–19
    //   aksam  19–23
    final hour = now.hour;
    final out = <TimeWindow>[];
    if (hour >= 11) out.add(TimeWindow.sabah);
    if (hour >= 15) out.add(TimeWindow.oglen);
    if (hour >= 19) out.add(TimeWindow.ikindi);
    if (hour >= 23) out.add(TimeWindow.aksam);
    return out;
  }
}

final missedSlotDetectorProvider = Provider<MissedSlotDetector>((ref) {
  return MissedSlotDetector(
    isar: ref.watch(isarProvider),
    sceneRepo: ref.watch(sceneRepositoryProvider),
    clock: ref.watch(clockProvider),
  );
});

/// Convenience entry point for main.dart — runs the detector once
/// and swallows errors (this is best-effort background bookkeeping).
Future<void> detectMissedSlotsOnStartup(ProviderContainer c) async {
  try {
    final profile = c.read(patientProfileProvider).value;
    if (profile == null) return;
    await c.read(missedSlotDetectorProvider).runFor(
          profileId: profile.profileId,
        );
  } catch (_) {
    // swallow — not worth surfacing to the patient.
  }
}
