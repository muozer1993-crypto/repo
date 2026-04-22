import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';

class ErgoterapiApp extends ConsumerWidget {
  const ErgoterapiApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Force landscape on tablets — the scene board is designed for
    // landscape slot positioning. Phones see an oversized tablet UI,
    // not ideal but acceptable during development.
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);

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
