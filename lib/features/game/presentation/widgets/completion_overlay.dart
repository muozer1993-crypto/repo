import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../../../shared/widgets/big_button.dart';

/// Shown when all targets are placed. Single CTA back to home.
///
/// No score, no star rating, no "X tries" — MCI patients get anxious
/// about performance metrics, and any ambient gamification risk
/// overrides the errorless-learning principle the rest of the player
/// is built on.
class CompletionOverlay extends StatelessWidget {
  const CompletionOverlay({required this.onDone, super.key});

  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.black.withValues(alpha: 0.55),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
          margin: const EdgeInsets.all(20),
          constraints: const BoxConstraints(maxWidth: 480),
          decoration: BoxDecoration(
            color: AppColors.background,
            borderRadius: BorderRadius.circular(24),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.check_circle_rounded,
                size: 80,
                color: AppColors.acceptGlow,
              ),
              const SizedBox(height: 16),
              Text(
                StringsTr.completionTitle,
                style: Theme.of(context).textTheme.headlineLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 28),
              BigButton(
                label: StringsTr.completionBackHome,
                onPressed: onDone,
                icon: Icons.home_rounded,
                expand: true,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
