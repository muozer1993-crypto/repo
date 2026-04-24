import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../../l10n/strings_tr.dart';
import '../../../shared/widgets/big_button.dart';
import '../../../shared/widgets/labeled_icon_button.dart';
import '../../game/application/scene_controller.dart';
import '../../game/presentation/bonus_player_screen.dart';
import '../../profile/data/profile_repository.dart';
import '../../progress/application/post_session_bonus.dart';
import '../../progress/application/scheduler_controller.dart';
import 'widgets/bonus_offer_tile.dart';

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
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  LabeledIconButton(
                    label: 'Ayarlar',
                    icon: Icons.settings_outlined,
                    tooltip: StringsTr.settingsTitle,
                    onTap: () => _openSettings(context),
                  ),
                  LabeledIconButton(
                    label: 'Kapat',
                    icon: Icons.close_rounded,
                    tooltip: 'Uygulamayı kapat',
                    onTap: () => _confirmClose(context),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              _WindowStatusStrip(current: window),
              const Spacer(),
              Text(
                _greetingFor(window, profile?.name),
                style: t.displayLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 32),
              if (window == TimeWindow.dinlenme)
                _RestState()
              else ...[
                _StartButton(),
                const SizedBox(height: 12),
                _PostSessionBonusOffer(window: window),
              ],
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

  Future<void> _confirmClose(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text(
          'Uygulamayı kapatmak istiyor musunuz?',
          style: TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w600,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Vazgeç', style: TextStyle(fontSize: 20)),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Evet, kapat'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    if (Platform.isAndroid) {
      SystemNavigator.pop();
    }
    // iOS intentionally not supported — Apple HIG forbids
    // programmatic quit; caregivers can swipe the app away.
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
        const SizedBox(height: 32),
        // v2 — always-on night-bonus tile when a night scene is
        // registered for today. If the scheduler has no night scene
        // it silently falls back to just the bypass link below.
        BonusOfferTile(
          titleTr: StringsTr.nightBonusHeadline,
          subtitleTr: StringsTr.nightBonusBody,
          compact: true,
          onAccept: () => _openNightBonus(context, ref),
          onDecline: () {}, // compact tile: no decline button rendered
        ),
        const SizedBox(height: 16),
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

  Future<void> _openNightBonus(BuildContext context, WidgetRef ref) async {
    // v2: the night-bonus scene id is fixed for now; Faz D will add
    // day-of-week rotation.
    ref.read(bonusPlayerArgsProvider.notifier).state = const BonusPlayerArgs(
      bonusSceneId: 'bonus_night_explore',
      nightBonus: true,
    );
    // ignore: use_build_context_synchronously
    context.push('/home/bonus');
  }

  Future<void> _bypass(BuildContext context, WidgetRef ref) async {
    final p = await ref.read(nightBypassPlanProvider.future);
    if (p == null || !context.mounted) return;
    ref.read(sceneArgsProvider.notifier).state = p.toArgs();
    // ignore: use_build_context_synchronously
    context.push('/home/play');
  }
}

/// v2 — horizontal strip of four pill tiles (one per dilim) showing
/// which window is currently active. Non-interactive; the scheduler
/// decides what launches when the patient taps "Başla" below.
class _WindowStatusStrip extends StatelessWidget {
  const _WindowStatusStrip({required this.current});

  final TimeWindow current;

  static const _windows = [
    (TimeWindow.sabah, 'Sabah', Icons.wb_sunny_rounded),
    (TimeWindow.oglen, 'Öğlen', Icons.wb_cloudy_rounded),
    (TimeWindow.ikindi, 'İkindi', Icons.local_cafe_rounded),
    (TimeWindow.aksam, 'Akşam', Icons.nights_stay_rounded),
  ];

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        for (final (w, label, icon) in _windows)
          _WindowPill(
            label: label,
            icon: icon,
            active: w == current,
          ),
      ],
    );
  }
}

class _WindowPill extends StatelessWidget {
  const _WindowPill({
    required this.label,
    required this.icon,
    required this.active,
  });

  final String label;
  final IconData icon;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: active
            ? AppColors.acceptGlow.withOpacity(0.3)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(24),
        border: Border.all(
          color: active ? AppColors.primary : AppColors.slotOutline,
          width: 2,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon,
              color: active ? AppColors.primary : AppColors.textMuted,
              size: 28),
          const SizedBox(height: 4),
          Text(
            label,
            style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: active ? AppColors.primary : AppColors.textMuted,
                ),
          ),
        ],
      ),
    );
  }
}

/// v2 — post-session bonus offer. Shown below the "Başla" button when
/// the scheduler signals that the current scene's bonus is available
/// for this entry (typically a 2nd+ entry into the current window on
/// the same day).
///
/// Faz D will wire [postSessionBonusAvailableProvider] to look at
/// today's SessionLog + BonusPlayEvent rows; for now the provider
/// returns null so nothing renders, keeping the home screen visually
/// unchanged until the flow is turned on.
class _PostSessionBonusOffer extends ConsumerWidget {
  const _PostSessionBonusOffer({required this.window});

  final TimeWindow window;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final offer = ref.watch(postSessionBonusAvailableProvider);
    return offer.when(
      data: (bonusSceneId) {
        if (bonusSceneId == null) return const SizedBox.shrink();
        return BonusOfferTile(
          titleTr: StringsTr.bonusOfferTitle,
          subtitleTr: StringsTr.bonusOfferBody,
          onAccept: () {
            ref.read(bonusPlayerArgsProvider.notifier).state = BonusPlayerArgs(
              bonusSceneId: bonusSceneId,
              nightBonus: false,
            );
            context.push('/home/bonus');
          },
          onDecline: () => ref
              .read(postSessionBonusAvailableProvider.notifier)
              .dismissForWindow(window),
        );
      },
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
    );
  }
}
