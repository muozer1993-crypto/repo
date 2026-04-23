import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:isar/isar.dart';
import 'package:uuid/uuid.dart';

import '../../../core/storage/isar_db.dart';
import '../domain/patient_profile.dart';

/// CRUD wrapper around the single [PatientProfile] row.
class ProfileRepository {
  ProfileRepository(this._isar);

  final Isar _isar;

  /// Returns the sole profile, or `null` when the app has never been
  /// configured.
  Future<PatientProfile?> load() =>
      _isar.patientProfiles.where().findFirst();

  /// Creates the initial profile. Generates the UUID that will later
  /// match `auth.uid()` on Supabase anonymous auth.
  Future<PatientProfile> create({
    required String name,
    required AgeBand ageBand,
  }) async {
    final profile = PatientProfile()
      ..name = name.trim()
      ..ageBand = ageBand
      ..createdAt = DateTime.now()
      ..profileId = const Uuid().v4();

    await _isar.writeTxn(() async {
      await _isar.patientProfiles.put(profile);
    });
    return profile;
  }

  Future<void> setReducedMotion(bool value) async {
    final existing = await load();
    if (existing == null) return;
    existing.reducedMotion = value;
    await _isar.writeTxn(() async {
      await _isar.patientProfiles.put(existing);
    });
  }

  Future<void> markSynced(DateTime at) async {
    final existing = await load();
    if (existing == null) return;
    existing.syncedAt = at;
    await _isar.writeTxn(() async {
      await _isar.patientProfiles.put(existing);
    });
  }

  /// Wipes the profile. Useful during development when the caregiver
  /// wants to start fresh without uninstalling the APK. Does NOT touch
  /// session logs or schedule entries — those remain for therapist
  /// continuity; but the router will redirect to /setup on next frame.
  Future<void> clear() async {
    await _isar.writeTxn(() async {
      await _isar.patientProfiles.clear();
    });
  }
}

final profileRepositoryProvider = Provider<ProfileRepository>((ref) {
  return ProfileRepository(ref.watch(isarProvider));
});

/// Watched stream of the current profile. `null` means not set up yet.
final patientProfileProvider = StreamProvider<PatientProfile?>((ref) {
  final isar = ref.watch(isarProvider);
  return isar.patientProfiles
      .where()
      .watch(fireImmediately: true)
      .map((rows) => rows.isEmpty ? null : rows.first);
});
