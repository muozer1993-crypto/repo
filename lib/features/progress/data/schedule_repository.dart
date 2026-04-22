import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';

import '../../../core/storage/isar_db.dart';
import '../application/spaced_retrieval.dart';
import '../domain/schedule_entry.dart';

/// Persists and hydrates [ScheduleEntry] rows.
class ScheduleRepository {
  ScheduleRepository(this._isar);

  final Isar _isar;

  /// Returns the entry for [sceneId] or a freshly-created one if the
  /// scene has never been played.
  Future<ScheduleEntry> forScene(
    String sceneId, {
    required DateTime now,
  }) async {
    final existing = await _isar.scheduleEntries
        .filter()
        .sceneIdEqualTo(sceneId)
        .findFirst();
    if (existing != null) return existing;
    final fresh = freshEntry(sceneId, now: now);
    await _isar.writeTxn(() async {
      await _isar.scheduleEntries.put(fresh);
    });
    return fresh;
  }

  Future<ScheduleEntry?> byId(Id id) => _isar.scheduleEntries.get(id);
}

final scheduleRepositoryProvider = Provider<ScheduleRepository>((ref) {
  return ScheduleRepository(ref.watch(isarProvider));
});
