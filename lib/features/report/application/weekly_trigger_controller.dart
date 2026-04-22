import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/sync/supabase_client_provider.dart';
import '../../../core/time/clock_provider.dart';
import '../../profile/data/profile_repository.dart';
import '../../progress/domain/app_open_event.dart';

/// Days between successful weekly report triggers.
const Duration kReportInterval = Duration(days: 7);

/// Exponential back-off on consecutive failures.
const List<Duration> kRetryBackoff = [
  Duration(hours: 2),
  Duration(hours: 6),
  Duration(days: 1),
  Duration(days: 2),
  Duration(days: 7),
];

/// Fire-and-forget weekly report trigger.
///
/// Runs once at app start:
///   1. Do we already have a [ReportTriggerState]? If no, seed it with
///      `lastTriggeredAt = null`, `nextRetryAt = now`.
///   2. If `nextRetryAt` is in the future, bail (not yet time).
///   3. If `lastTriggeredAt != null` AND `now - lastTriggeredAt < 7d`
///      AND no pending retry, bail (report not due yet).
///   4. Otherwise, POST to the `send-weekly-report` Edge Function with
///      `{ profile_id }` as body. Fire-and-forget — we don't wait for
///      success before returning control to the UI.
///   5. On 2xx, set `lastTriggeredAt = now`, clear `consecutiveFailures`
///      and `nextRetryAt`. On error, increment `consecutiveFailures`
///      and set `nextRetryAt = now + kRetryBackoff[min(idx, last)]`.
///
/// Never surfaces success or failure to the patient/caregiver.
class WeeklyTriggerController {
  WeeklyTriggerController({
    required this.isar,
    required this.client,
    required this.clock,
    required this.profileId,
  });

  final Isar isar;
  final SupabaseClient? client;
  final DateTime Function() clock;
  final String profileId;

  Future<void> runOnAppStart() async {
    if (client == null || profileId.isEmpty) return;

    final state = await _loadOrSeed();
    final now = clock();

    final due = _isDue(state, now);
    if (!due) return;

    try {
      await client!.functions.invoke(
        'send-weekly-report',
        body: {'profile_id': profileId},
      );
      await _markSuccess(state, now);
    } catch (e) {
      debugPrint('weekly trigger failed: $e');
      await _markFailure(state, now);
    }
  }

  Future<ReportTriggerState> _loadOrSeed() async {
    final existing = await isar.reportTriggerStates.get(1);
    if (existing != null) return existing;
    final seed = ReportTriggerState()..id = 1;
    await isar.writeTxn(() async {
      await isar.reportTriggerStates.put(seed);
    });
    return seed;
  }

  bool _isDue(ReportTriggerState s, DateTime now) {
    // Honour exponential backoff.
    final retry = s.nextRetryAt;
    if (retry != null && retry.isAfter(now)) return false;

    // If we've never triggered, go immediately.
    final last = s.lastTriggeredAt;
    if (last == null) return true;

    return now.difference(last) >= kReportInterval;
  }

  Future<void> _markSuccess(ReportTriggerState s, DateTime now) async {
    s
      ..lastTriggeredAt = now
      ..nextRetryAt = null
      ..consecutiveFailures = 0;
    await isar.writeTxn(() async {
      await isar.reportTriggerStates.put(s);
    });
  }

  Future<void> _markFailure(ReportTriggerState s, DateTime now) async {
    final idx = s.consecutiveFailures.clamp(0, kRetryBackoff.length - 1);
    s
      ..consecutiveFailures = s.consecutiveFailures + 1
      ..nextRetryAt = now.add(kRetryBackoff[idx]);
    await isar.writeTxn(() async {
      await isar.reportTriggerStates.put(s);
    });
  }
}

final weeklyTriggerControllerProvider =
    Provider<WeeklyTriggerController>((ref) {
  final profile = ref.watch(patientProfileProvider).value;
  return WeeklyTriggerController(
    isar: ref.watch(isarProvider),
    client: ref.watch(supabaseClientProvider),
    clock: ref.watch(clockProvider),
    profileId: profile?.profileId ?? '',
  );
});
