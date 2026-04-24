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
class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 48),
          child: Column(
            children: [
              const Spacer(),
              Icon(
                Icons.group_rounded,
                size: 96,
                color: AppColors.primary.withOpacity(0.8),
              ),
              const SizedBox(height: 32),
              AutoSizeText(
                StringsTr.onboardingTitle,
                style: Theme.of(context)
                    .textTheme
                    .displaySmall
                    ?.copyWith(color: AppColors.primaryDark),
                maxLines: 2,
                minFontSize: 24,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 640),
                child: AutoSizeText(
                  StringsTr.onboardingBody,
                  style: Theme.of(context).textTheme.bodyLarge,
                  maxLines: 8,
                  minFontSize: 16,
                  textAlign: TextAlign.center,
                ),
              ),
              const Spacer(),
              Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: () => _dismiss(context, ref, caregiver: true),
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 80),
                        textStyle: Theme.of(context).textTheme.titleLarge,
                      ),
                      child: const Text(StringsTr.onboardingInvite),
                    ),
                  ),
                  const SizedBox(width: 16),
                  BigButton(
                    label: StringsTr.onboardingStart,
                    icon: Icons.play_arrow_rounded,
                    onPressed: () =>
                        _dismiss(context, ref, caregiver: false),
                  ),
                ],
              ),
            ],
          ),
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
      // Show a caregiver tip card briefly before routing home. Kept
      // deliberately minimal — any deeper caregiver flow lives in the
      // v3 companion web app (per plan scope).
      await showDialog<void>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text(StringsTr.onboardingInvite),
          content: const Text(
            'Hastanın yanında oturun, sahneyi birlikte seyredin ve '
            'yönergeleri birlikte dinleyin. Hata yapmasına izin verin — '
            'sistem otomatik hatırlatma verir.',
            style: TextStyle(fontSize: 18),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Anladım'),
            ),
          ],
        ),
      );
    }
    if (!context.mounted) return;
    context.go('/home');
  }
}
