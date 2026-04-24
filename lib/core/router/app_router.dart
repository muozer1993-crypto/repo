import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/game/presentation/bonus_player_screen.dart';
import '../../features/game/presentation/scene_player_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/home/presentation/settings_screen.dart';
import '../../features/onboarding/presentation/onboarding_screen.dart';
import '../../features/profile/data/profile_repository.dart';
import '../../features/profile/presentation/profile_setup_screen.dart';

/// The GoRouter instance. Redirects to /setup when no profile exists,
/// to /home otherwise.
final appRouterProvider = Provider<GoRouter>((ref) {
  final profile = ref.watch(patientProfileProvider);
  return GoRouter(
    initialLocation: '/home',
    redirect: (context, state) {
      final current = profile.value;
      final hasProfile = current != null;
      final onboardingSeen = current?.onboardingSeen ?? true;
      final loc = state.matchedLocation;

      if (!hasProfile && loc != '/setup') return '/setup';
      if (hasProfile && loc == '/setup') {
        return onboardingSeen ? '/home' : '/onboarding';
      }
      if (hasProfile && !onboardingSeen && loc == '/home') {
        return '/onboarding';
      }
      if (hasProfile && onboardingSeen && loc == '/onboarding') {
        return '/home';
      }
      return null;
    },
    refreshListenable: _ProfileListenable(ref),
    routes: [
      GoRoute(
        path: '/setup',
        builder: (_, __) => const ProfileSetupScreen(),
      ),
      GoRoute(
        path: '/onboarding',
        builder: (_, __) => const OnboardingScreen(),
      ),
      GoRoute(
        path: '/home',
        builder: (_, __) => const HomeScreen(),
        routes: [
          GoRoute(
            path: 'play',
            builder: (_, __) => const ScenePlayerScreen(),
          ),
          // v2 — bonus player is reachable from the home screen's
          // post-session offer tile and from the night-bonus compact
          // tile during dinlenme.
          GoRoute(
            path: 'bonus',
            builder: (_, __) => const BonusPlayerScreen(),
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
