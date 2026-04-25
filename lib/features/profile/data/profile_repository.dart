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

  /// v2 — flips onboardingSeen to true so the router stops redirecting
  /// freshly-setup profiles to /onboarding.
  Future<void> markOnboardingSeen() async {
    final existing = await load();
    if (existing == null) return;
    existing.onboardingSeen = true;
    await _isar.writeTxn(() async {
      await _isar.patientProfiles.put(existing);
    });
  }

  /// v2 — replaces the local profileId with the Supabase-issued
  /// auth.uid() so every row's profile_id matches what RLS expects.
  /// Rewrites all not-yet-synced rows (AppOpenEvent, SessionLog,
  /// PlacementEvent, BonusPlayEvent, MissedSlotEvent) so they don't
  /// fail their first sync attempt on the old uuid.
  Future<void> alignProfileIdWithAuth(String newProfileId) async {
    final existing = await load();
    if (existing == null) return;
    if (existing.profileId == newProfileId) return;
    final oldId = existing.profileId;

    await _isar.writeTxn(() async {
      existing
        ..profileId = newProfileId
        ..syncedAt = DateTime.now();
      await _isar.patientProfiles.put(existing);

      // Rewrite unsynced rows. We can't reach those collections from
      // here without their imports, so do it dynamically — keeps this
      // file dependency-light.
      Future<void> rewrite(dynamic collection, String accessor) async {
        final pending = await collection
            .filter()
            .syncedAtIsNull()
            .findAll() as List;
        for (final row in pending) {
          if ((row as dynamic).profileId == oldId) {
            (row as dynamic).profileId = newProfileId;
            await collection.put(row);
          }
        }
      }

      // ignore: avoid_dynamic_calls
      await rewrite(_isar.appOpenEvents, 'appOpenEvents');
      // ignore: avoid_dynamic_calls
      await rewrite(_isar.sessionLogs, 'sessionLogs');
      // ignore: avoid_dynamic_calls
      await rewrite(_isar.placementEvents, 'placementEvents');
      // ignore: avoid_dynamic_calls
      await rewrite((_isar as dynamic).bonusPlayEvents, 'bonusPlayEvents');
      // ignore: avoid_dynamic_calls
      await rewrite((_isar as dynamic).missedSlotEvents, 'missedSlotEvents');
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
