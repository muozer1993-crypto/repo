import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';
import 'package:path_provider/path_provider.dart';

import '../../features/profile/domain/patient_profile.dart';
import '../../features/progress/domain/app_open_event.dart';
import '../../features/progress/domain/bonus_play_event.dart';
import '../../features/progress/domain/missed_slot_event.dart';
import '../../features/progress/domain/schedule_entry.dart';
import '../../features/progress/domain/session_log.dart';

/// Opens the single Isar instance used across the app.
///
/// Registered collections:
///   * [PatientProfile]
///   * [SessionLog]
///   * [PlacementEvent]
///   * [ScheduleEntry]
///   * [AppOpenEvent]
///   * [ReportTriggerState]
///   * [BonusPlayEvent]   (v2)
///   * [MissedSlotEvent]  (v2)
Future<Isar> openIsar() async {
  final dir = await getApplicationDocumentsDirectory();
  return Isar.open(
    [
      PatientProfileSchema,
      SessionLogSchema,
      PlacementEventSchema,
      ScheduleEntrySchema,
      AppOpenEventSchema,
      ReportTriggerStateSchema,
      BonusPlayEventSchema,
      MissedSlotEventSchema,
    ],
    directory: dir.path,
    name: 'ergoterapi',
    inspector: false,
  );
}

/// Async provider that resolves once Isar has finished opening.
///
/// Most feature code should NOT depend on this directly; instead depend
/// on the small [isarProvider] below which yields the underlying Isar
/// instance once it is ready (and throws until then).
final _isarFutureProvider = FutureProvider<Isar>((_) => openIsar());

/// Synchronous accessor. Caller is responsible for awaiting
/// `_isarFutureProvider.future` at app startup (in `main.dart`)
/// so that by the time any widget reads this, Isar is open.
final isarProvider = Provider<Isar>((ref) {
  final async = ref.watch(_isarFutureProvider);
  return async.when(
    data: (isar) => isar,
    loading: () =>
        throw StateError('Isar not ready — await _isarFutureProvider.future '
            'at app startup before reading isarProvider.'),
    error: (e, st) => throw StateError('Failed to open Isar: $e'),
  );
});

/// Call during `main()` before `runApp` so widgets can read
/// [isarProvider] synchronously.
Future<void> warmUpIsar(ProviderContainer container) async {
  await container.read(_isarFutureProvider.future);
}
