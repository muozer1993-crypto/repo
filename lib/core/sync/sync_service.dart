import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../features/progress/domain/app_open_event.dart';
import '../../features/progress/domain/bonus_play_event.dart';
import '../../features/progress/domain/missed_slot_event.dart';
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
      _pushBonusPlays(),
      _pushMissedSlots(),
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

  Future<void> _pushBonusPlays() async {
    final pending =
        await isar.bonusPlayEvents.filter().syncedAtIsNull().findAll();
    if (pending.isEmpty) return;
    try {
      await client!.from('bonus_plays').upsert(
            pending.map(_bonusPlayToRow).toList(),
          );
      final now = DateTime.now();
      await isar.writeTxn(() async {
        for (final b in pending) {
          b.syncedAt = now;
          await isar.bonusPlayEvents.put(b);
        }
      });
    } catch (e) {
      debugPrint('sync bonus_plays failed: $e');
    }
  }

  Future<void> _pushMissedSlots() async {
    final pending =
        await isar.missedSlotEvents.filter().syncedAtIsNull().findAll();
    if (pending.isEmpty) return;
    try {
      // unique(profile_id, time_window, missed_on) server-side — upsert
      // with onConflict makes the call idempotent across retries.
      await client!.from('missed_slots').upsert(
            pending.map(_missedSlotToRow).toList(),
            onConflict: 'profile_id,time_window,missed_on',
          );
      final now = DateTime.now();
      await isar.writeTxn(() async {
        for (final m in pending) {
          m.syncedAt = now;
          await isar.missedSlotEvents.put(m);
        }
      });
    } catch (e) {
      debugPrint('sync missed_slots failed: $e');
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
        // v2 columns
        'game1_error_count': s.game1ErrorCount,
        'game1_completed': s.game1Completed,
        'game2_error_count': s.game2ErrorCount,
        'game2_completed': s.game2Completed,
        'game2_type': s.game2Type,
        'item_combo_hash': s.itemComboHash,
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
        // v2 column
        'game_type': p.gameType,
      };

  Map<String, dynamic> _appOpenToRow(AppOpenEvent a) => {
        'profile_id': a.profileId,
        'at': a.at.toUtc().toIso8601String(),
        'time_window': a.timeWindow,
      };

  Map<String, dynamic> _bonusPlayToRow(BonusPlayEvent b) => {
        'id': b.bonusPlayId,
        'profile_id': b.profileId,
        'bonus_scene_id': b.bonusSceneId,
        'bonus_type': b.bonusType,
        'started_at': b.startedAt.toUtc().toIso8601String(),
        'finished_at': b.finishedAt?.toUtc().toIso8601String(),
        'tap_count': b.tapCount,
        'night_bonus': b.nightBonus,
        'time_window': b.timeWindow,
      };

  Map<String, dynamic> _missedSlotToRow(MissedSlotEvent m) => {
        'profile_id': m.profileId,
        'time_window': m.timeWindow,
        'scene_id': m.sceneId,
        'missed_on':
            '${m.missedOn.year.toString().padLeft(4, '0')}-${m.missedOn.month.toString().padLeft(2, '0')}-${m.missedOn.day.toString().padLeft(2, '0')}',
        'detected_at': m.detectedAt.toUtc().toIso8601String(),
      };
}

final syncServiceProvider = Provider<SyncService>((ref) {
  return SyncService(
    isar: ref.watch(isarProvider),
    client: ref.watch(supabaseClientProvider),
  );
});
