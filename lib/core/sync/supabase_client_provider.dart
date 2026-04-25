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
Future<void> ensureAnonSession(ProviderContainer container) async {
  final client = container.read(supabaseClientProvider);
  if (client == null) return;

  final profile = await container.read(profileRepositoryProvider).load();
  if (profile == null) return;

  try {
    if (client.auth.currentUser == null) {
      await client.auth.signInAnonymously();
    }
    final serverUid = client.auth.currentUser?.id;
    if (serverUid == null) return;

    // Align the local profileId with auth.uid() FIRST. RLS policies
    // check `profile_id::text = auth.uid()::text` on every table, so
    // any pending unsynced rows must be rewritten before the upsert
    // tries to push them.
    if (profile.profileId != serverUid) {
      await container
          .read(profileRepositoryProvider)
          .alignProfileIdWithAuth(serverUid);
    }

    await client.from('profiles').upsert({
      'id': serverUid,
      'name': profile.name,
      'age_band': profile.ageBand.name,
      'therapist_email': BuildConfig.therapistEmail,
    });

    if (profile.syncedAt == null) {
      await container
          .read(profileRepositoryProvider)
          .markSynced(DateTime.now());
    }
  } catch (e) {
    debugPrint('supabase anon auth failed: $e');
  }
}
