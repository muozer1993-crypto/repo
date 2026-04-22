import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/game/presentation/scene_player_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/home/presentation/settings_screen.dart';
import '../../features/profile/data/profile_repository.dart';
import '../../features/profile/presentation/profile_setup_screen.dart';

/// The GoRouter instance. Redirects to /setup when no profile exists,
/// to /home otherwise.
final appRouterProvider = Provider<GoRouter>((ref) {
  final profile = ref.watch(patientProfileProvider);
  return GoRouter(
    initialLocation: '/home',
    redirect: (context, state) {
      final hasProfile = profile.value != null;
      final goingToSetup = state.matchedLocation == '/setup';
      if (!hasProfile && !goingToSetup) return '/setup';
      if (hasProfile && goingToSetup) return '/home';
      return null;
    },
    refreshListenable: _ProfileListenable(ref),
    routes: [
      GoRoute(
        path: '/setup',
        builder: (_, __) => const ProfileSetupScreen(),
      ),
      GoRoute(
        path: '/home',
        builder: (_, __) => const HomeScreen(),
        routes: [
          GoRoute(
            path: 'play',
            builder: (_, __) => const ScenePlayerScreen(),
          ),
          GoRoute(
            path: 'settings',
            builder: (_, __) => const SettingsScreen(),
          ),
        ],
      ),
    ],
  );
});

/// Adapter that refreshes the router when the watched profile changes.
class _ProfileListenable extends ChangeNotifier {
  _ProfileListenable(Ref ref) {
    ref.listen(patientProfileProvider, (_, __) {
      notifyListeners();
    });
  }
}
