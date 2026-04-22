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

  // 3) Anon auth + profile upsert. Best-effort.
  //    ignore_for_file: unused_result
  // We run this without awaiting because losing network on launch
  // must not block the patient from playing.
  unawaited(ensureAnonSession(container));

  // 4) Log this app-open. Reads profile after Isar is warm; if the
  //    profile is not yet set up, we simply skip.
  await _logAppOpen(container);

  // 5) Sync pending rows + fire-and-forget weekly report trigger.
  unawaited(container.read(syncServiceProvider).pushAll());
  unawaited(
    container.read(weeklyTriggerControllerProvider).runOnAppStart(),
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

