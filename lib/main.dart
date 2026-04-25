import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/storage/isar_db.dart';
import 'core/sync/supabase_client_provider.dart';
import 'core/sync/sync_service.dart';
import 'core/time/clock_provider.dart';
import 'core/time/time_window.dart';
import 'features/profile/data/profile_repository.dart';
import 'features/progress/application/missed_slot_detector.dart';
import 'features/progress/domain/app_open_event.dart';
import 'features/report/application/weekly_trigger_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final container = ProviderContainer();

  // 1) Open Isar (profile + session log + etc).
  await warmUpIsar(container);

  // 2) Initialize Supabase if dart-defines are present (no-op
  //    otherwise — local-only dev stays functional).
  await initializeSupabase();

  // 3) Log this app-open first. Reads profile after Isar is warm; if
  //    the profile is not yet set up, we simply skip. Runs before
  //    cloud auth so even offline launches log the open.
  await _logAppOpen(container);

  // 4) v2 — detect any time windows that closed today without the
  //    patient playing and emit MissedSlotEvent rows. Idempotent and
  //    silent on error.
  unawaited(detectMissedSlotsOnStartup(container));

  // 5) Anon auth + profile upsert + sync chain. We chain sync after
  //    auth so RLS sees the aligned auth.uid()/profile_id pair on
  //    the very first push attempt; previous design was racing
  //    pushAll against the anonymous sign-in and getting 42501
  //    "row violates row-level security policy" rejections.
  unawaited(
    ensureAnonSession(container).then((_) async {
      await container.read(syncServiceProvider).pushAll();
      await container.read(weeklyTriggerControllerProvider).runOnAppStart();
    }),
  );

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: const ErgoterapiApp(),
    ),
  );
}

Future<void> _logAppOpen(ProviderContainer container) async {
  final profile = await container.read(profileRepositoryProvider).load();
  if (profile == null) return;
  final now = container.read(clockProvider)();
  final event = AppOpenEvent()
    ..profileId = profile.profileId
    ..at = now
    ..timeWindow = timeWindowId(windowFor(now));
  final isar = container.read(isarProvider);
  await isar.writeTxn(() async {
    await isar.appOpenEvents.put(event);
  });
}

