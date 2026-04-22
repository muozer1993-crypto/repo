import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../features/progress/domain/app_open_event.dart';
import '../../features/progress/domain/session_log.dart';
import '../storage/isar_db.dart';
import 'supabase_client_provider.dart';

/// Pushes rows with `syncedAt IS NULL` up to Supabase and marks them
/// synced on success.
///
/// Best-effort: on any failure we leave rows unsynced and retry on the
/// next invocation. There's no delete-on-server path and no conflict
/// resolution — the local DB is authoritative and the server is a
/// write-only sink for the weekly report.
class SyncService {
  SyncService({required this.isar, required this.client});

  final Isar isar;
  final SupabaseClient? client;

  Future<void> pushAll() async {
    if (client == null) return;
    await Future.wait([
      _pushSessions(),
      _pushPlacements(),
      _pushAppOpens(),
    ]);
  }

  Future<void> _pushSessions() async {
    final pending =
        await isar.sessionLogs.filter().syncedAtIsNull().findAll();
    if (pending.isEmpty) return;
    try {
      await client!.from('sessions').upsert(
            pending.map(_sessionToRow).toList(),
          );
      final now = DateTime.now();
      await isar.writeTxn(() async {
        for (final s in pending) {
          s.syncedAt = now;
          await isar.sessionLogs.put(s);
        }
      });
    } catch (e) {
      debugPrint('sync sessions failed: $e');
    }
  }

  Future<void> _pushPlacements() async {
    final pending =
        await isar.placementEvents.filter().syncedAtIsNull().findAll();
    if (pending.isEmpty) return;
    try {
      await client!.from('placements').upsert(
            pending.map(_placementToRow).toList(),
          );
      final now = DateTime.now();
      await isar.writeTxn(() async {
        for (final p in pending) {
          p.syncedAt = now;
          await isar.placementEvents.put(p);
        }
      });
    } catch (e) {
      debugPrint('sync placements failed: $e');
    }
  }

  Future<void> _pushAppOpens() async {
    final pending =
        await isar.appOpenEvents.filter().syncedAtIsNull().findAll();
    if (pending.isEmpty) return;
    try {
      await client!.from('app_opens').upsert(
            pending.map(_appOpenToRow).toList(),
          );
      final now = DateTime.now();
      await isar.writeTxn(() async {
        for (final a in pending) {
          a.syncedAt = now;
          await isar.appOpenEvents.put(a);
        }
      });
    } catch (e) {
      debugPrint('sync app_opens failed: $e');
    }
  }

  Map<String, dynamic> _sessionToRow(SessionLog s) => {
        'id': s.sessionId,
        'profile_id': s.profileId,
        'scene_id': s.sceneId,
        'started_at': s.startedAt.toUtc().toIso8601String(),
        'finished_at': s.finishedAt?.toUtc().toIso8601String(),
        'error_count': s.errorCount,
        'completed': s.completed,
        'sr_interval_start': s.srIntervalAtStart,
        'sr_interval_end': s.srIntervalAtEnd,
        'difficulty_start': s.difficultyAtStart,
        'difficulty_end': s.difficultyAtEnd,
        'orientation_correct': s.orientationCorrect,
        'orientation_response_ms': s.orientationResponseMs,
        'instruction_replay_count': s.instructionReplayCount,
      };

  Map<String, dynamic> _placementToRow(PlacementEvent p) => {
        'profile_id': p.profileId,
        'session_id': p.sessionId,
        'item_id': p.itemId,
        'target_slot_id': p.targetSlotId,
        'correct': p.correct,
        'tapped_distractor': p.tappedDistractor,
        'reaction_ms': p.reactionTimeMs,
        'wait_ms': p.waitTimeMs,
        'at': p.at.toUtc().toIso8601String(),
        'item_count_at_scene': p.itemCountAtScene,
        'distractor_category': p.distractorCategory,
        'sequence_required': p.sequenceRequired,
        'difficulty_level': p.difficultyLevel,
      };

  Map<String, dynamic> _appOpenToRow(AppOpenEvent a) => {
        'profile_id': a.profileId,
        'at': a.at.toUtc().toIso8601String(),
        'time_window': a.timeWindow,
      };
}

final syncServiceProvider = Provider<SyncService>((ref) {
  return SyncService(
    isar: ref.watch(isarProvider),
    client: ref.watch(supabaseClientProvider),
  );
});
