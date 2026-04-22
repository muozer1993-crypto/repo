import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../../l10n/strings_tr.dart';
import '../../../shared/widgets/big_button.dart';
import '../../game/application/scene_controller.dart';
import '../../profile/data/profile_repository.dart';
import '../../progress/application/scheduler_controller.dart';

/// Patient-facing home screen.
///
/// Deliberately simple: greeting + one big "Başla" button. During
/// dinlenme (23:00–06:00), the Başla button is replaced by a rest
/// message and a small low-contrast "Yine de bir oyun oyna" link
/// (soft lock, not a hard block).
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = ref.watch(clockProvider)();
    final window = windowFor(now);
    final profile = ref.watch(patientProfileProvider).value;
    final t = Theme.of(context).textTheme;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: IconButton(
                  onPressed: () => _openSettings(context),
                  icon: const Icon(Icons.settings_outlined, size: 32),
                  tooltip: StringsTr.settingsTitle,
                ),
              ),
              const Spacer(),
              Text(
                _greetingFor(window, profile?.name),
                style: t.displayLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 48),
              if (window == TimeWindow.dinlenme)
                _RestState()
              else
                _StartButton(),
              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }

  void _openSettings(BuildContext context) {
    context.push('/home/settings');
  }

  String _greetingFor(TimeWindow window, String? name) {
    final base = switch (window) {
      TimeWindow.sabah => StringsTr.greetingSabah,
      TimeWindow.oglen => StringsTr.greetingOglen,
      TimeWindow.ikindi => StringsTr.greetingIkindi,
      TimeWindow.aksam => StringsTr.greetingAksam,
      TimeWindow.dinlenme => StringsTr.greetingDinlenme,
    };
    if (name == null || name.isEmpty || window == TimeWindow.dinlenme) {
      return base;
    }
    return '$base, $name';
  }
}

class _StartButton extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final plan = ref.watch(launchPlanProvider);
    return plan.when(
      data: (p) {
        if (p == null) return const SizedBox.shrink();
        return BigButton(
          label: StringsTr.startButton,
          icon: Icons.play_arrow_rounded,
          onPressed: () => _launch(context, ref, p),
        );
      },
      loading: () => const CircularProgressIndicator(),
      error: (_, __) => const SizedBox.shrink(),
    );
  }

  void _launch(BuildContext context, WidgetRef ref, LaunchPlan p) {
    ref.read(sceneArgsProvider.notifier).state = p.toArgs();
    context.push('/home/play');
  }
}

class _RestState extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      children: [
        const Icon(Icons.nightlight_round, size: 96, color: AppColors.primary),
        const SizedBox(height: 16),
        Text(
          StringsTr.greetingDinlenme,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                color: AppColors.textSecondary,
              ),
        ),
        const SizedBox(height: 48),
        TextButton(
          onPressed: () => _bypass(context, ref),
          style: TextButton.styleFrom(
            foregroundColor: AppColors.textMuted,
          ),
          child: const Text(
            StringsTr.nightBypassLink,
            style: TextStyle(fontSize: 18),
          ),
        ),
      ],
    );
  }

  Future<void> _bypass(BuildContext context, WidgetRef ref) async {
    final p = await ref.read(nightBypassPlanProvider.future);
    if (p == null || !context.mounted) return;
    ref.read(sceneArgsProvider.notifier).state = p.toArgs();
    // ignore: use_build_context_synchronously
    context.push('/home/play');
  }
}
