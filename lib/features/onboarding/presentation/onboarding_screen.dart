import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/strings_tr.dart';
import '../../../shared/widgets/big_button.dart';
import '../../profile/data/profile_repository.dart';

/// v2 — caregiver-invite screen shown once, immediately after profile
/// setup. Two buttons: "Şimdi başla" goes straight to /home; "Eşlik
/// et" shows a caregiver-facing tip card then goes to /home. Either
/// button flips onboardingSeen=true on the profile so this screen
/// never re-renders for the same patient.
///
/// Layout invariants:
///   * Scroll-tolerant — never overflows in landscape, even on narrow
///     phones; the body is always reachable.
///   * No word-breaking — every AutoSizeText uses wrapWords: false so
///     "Eşlik" is not split across lines as "Eşl"/"ik".
///   * Both buttons render as filled buttons with distinct colours so
///     it's visually obvious which is the primary action.
class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final isTight = constraints.maxHeight < 520;
            return SingleChildScrollView(
              padding: const EdgeInsets.symmetric(
                horizontal: 32,
                vertical: 24,
              ),
              child: ConstrainedBox(
                constraints:
                    BoxConstraints(minHeight: constraints.maxHeight - 48),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    if (!isTight) const SizedBox(height: 16),
                    Icon(
                      Icons.group_rounded,
                      size: isTight ? 56 : 96,
                      color: AppColors.primary.withOpacity(0.85),
                    ),
                    SizedBox(height: isTight ? 16 : 24),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 640),
                      child: AutoSizeText(
                        StringsTr.onboardingTitle,
                        style: Theme.of(context)
                            .textTheme
                            .displaySmall
                            ?.copyWith(
                              color: AppColors.primaryDark,
                              fontWeight: FontWeight.w600,
                            ),
                        maxLines: 2,
                        minFontSize: 20,
                        wrapWords: false,
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: 16),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 640),
                      child: AutoSizeText(
                        StringsTr.onboardingBody,
                        style: Theme.of(context).textTheme.bodyLarge,
                        maxLines: 8,
                        minFontSize: 14,
                        wrapWords: false,
                        textAlign: TextAlign.center,
                      ),
                    ),
                    SizedBox(height: isTight ? 24 : 40),
                    _ButtonRow(
                      compact: isTight,
                      onCaregiver: () =>
                          _dismiss(context, ref, caregiver: true),
                      onStart: () => _dismiss(context, ref, caregiver: false),
                    ),
                    const SizedBox(height: 8),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Future<void> _dismiss(
    BuildContext context,
    WidgetRef ref, {
    required bool caregiver,
  }) async {
    await ref.read(profileRepositoryProvider).markOnboardingSeen();
    if (!context.mounted) return;
    if (caregiver) {
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => AlertDialog(
          title: const Text(
            StringsTr.onboardingInvite,
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Hastanın yanında oturun, sahneyi birlikte seyredin ve '
                'yönergeleri birlikte dinleyin. Hata yapmasına izin verin — '
                'sistem otomatik hatırlatma verir.',
                style: TextStyle(fontSize: 16),
              ),
              const SizedBox(height: 20),
              BigButton(
                label: 'Anladım',
                icon: Icons.check_rounded,
                variant: BigButtonVariant.primary,
                expand: true,
                compact: true,
                onPressed: () => Navigator.of(context).pop(),
              ),
            ],
          ),
          actionsPadding: EdgeInsets.zero,
          actions: const [],
        ),
      );
    }
    if (!context.mounted) return;
    context.go('/home');
  }
}

class _ButtonRow extends StatelessWidget {
  const _ButtonRow({
    required this.compact,
    required this.onCaregiver,
    required this.onStart,
  });

  final bool compact;
  final VoidCallback onCaregiver;
  final VoidCallback onStart;

  @override
  Widget build(BuildContext context) {
    // In tight (landscape phone) mode stack vertically so neither button
    // gets squashed; in roomy mode display side-by-side for the
    // primary-on-the-right convention.
    final isWide = MediaQuery.of(context).size.width > 600 && !compact;
    if (isWide) {
      return Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          BigButton(
            label: StringsTr.onboardingInvite,
            icon: Icons.handshake_rounded,
            variant: BigButtonVariant.warning,
            onPressed: onCaregiver,
            compact: compact,
          ),
          const SizedBox(width: 16),
          BigButton(
            label: StringsTr.onboardingStart,
            icon: Icons.play_arrow_rounded,
            variant: BigButtonVariant.primary,
            onPressed: onStart,
            compact: compact,
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        BigButton(
          label: StringsTr.onboardingStart,
          icon: Icons.play_arrow_rounded,
          variant: BigButtonVariant.primary,
          onPressed: onStart,
          expand: true,
          compact: compact,
        ),
        const SizedBox(height: 12),
        BigButton(
          label: StringsTr.onboardingInvite,
          icon: Icons.handshake_rounded,
          variant: BigButtonVariant.warning,
          onPressed: onCaregiver,
          expand: true,
          compact: compact,
        ),
      ],
    );
  }
}
