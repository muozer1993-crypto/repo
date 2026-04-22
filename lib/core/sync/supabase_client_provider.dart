import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../config/build_config.dart';
import '../../features/profile/data/profile_repository.dart';

/// One-time Supabase initialization. Safe to call multiple times; the
/// underlying `Supabase.initialize` is idempotent on subsequent calls.
Future<void> initializeSupabase() async {
  if (!BuildConfig.cloudEnabled) return;
  await Supabase.initialize(
    url: BuildConfig.supabaseUrl,
    anonKey: BuildConfig.supabaseAnonKey,
  );
}

/// Exposes the initialized [SupabaseClient]. Null when cloud is not
/// configured via dart-defines (local-only dev builds).
final supabaseClientProvider = Provider<SupabaseClient?>((_) {
  if (!BuildConfig.cloudEnabled) return null;
  return Supabase.instance.client;
});

/// Ensures the device is signed in anonymously and the signed-in
/// `auth.uid()` matches the local [PatientProfile.profileId].
///
/// If the anon session doesn't exist yet, creates one. Upserts the
/// profile row on Supabase so RLS policies can match auth.uid() on
/// subsequent writes.
Future<void> ensureAnonSession(ProviderRef<Object?> ref) async {
  final client = ref.read(supabaseClientProvider);
  if (client == null) return;

  final profile = await ref.read(profileRepositoryProvider).load();
  if (profile == null) return;

  try {
    // If there's no session, sign in anonymously. Supabase yields a
    // fresh anon user with auth.uid() != our profileId, so we have to
    // reconcile: we upsert the profile row under the SERVER's uid.
    // Subsequent writes in SyncService use that server-provided uid.
    if (client.auth.currentUser == null) {
      await client.auth.signInAnonymously();
    }
    final serverUid = client.auth.currentUser?.id;
    if (serverUid == null) return;

    // Upsert profile row; server uid becomes the canonical profile_id
    // the device will use for all subsequent writes.
    await client.from('profiles').upsert({
      'id': serverUid,
      'name': profile.name,
      'age_band': profile.ageBand.name,
      'therapist_email': BuildConfig.therapistEmail,
    });

    // Propagate the server-side uid into the local profile so later
    // upserts and WeeklyTriggerController use the same id.
    if (profile.profileId != serverUid || profile.syncedAt == null) {
      profile
        ..profileId = serverUid
        ..syncedAt = DateTime.now();
      await ref.read(profileRepositoryProvider).markSynced(DateTime.now());
    }
  } catch (e) {
    debugPrint('supabase anon auth failed: $e');
  }
}
