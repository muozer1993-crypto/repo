import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';

class ErgoterapiApp extends ConsumerWidget {
  const ErgoterapiApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Orientation is left to the OS — phones default to portrait (more
    // vertical room), tablets work in either orientation. Forcing
    // landscape (the previous behavior) made every screen overflow on
    // phones because phone landscape height is only ~412dp.
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      title: 'Ergoterapi',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      routerConfig: router,
      supportedLocales: const [Locale('tr', 'TR')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
    );
  }
}
