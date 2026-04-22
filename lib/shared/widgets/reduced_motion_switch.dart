import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import '../../core/theme/motion.dart';

/// Caregiver-facing toggle for reduced-motion preference.
///
/// Lives in a settings screen (not on the patient's main flow) since MCI
/// patients are not expected to manage their own preferences.
class ReducedMotionSwitch extends ConsumerWidget {
  const ReducedMotionSwitch({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isReduced = ref.watch(reducedMotionProvider);
    return SwitchListTile(
      value: isReduced,
      onChanged: (v) => ref.read(reducedMotionProvider.notifier).state = v,
      title: const Text(
        'Hareketi azalt',
        style: TextStyle(fontSize: 24, color: AppColors.textPrimary),
      ),
      subtitle: const Text(
        'Nabız ve kutlama animasyonlarını kapatır.',
        style: TextStyle(fontSize: 18, color: AppColors.textSecondary),
      ),
      activeColor: AppColors.primary,
      contentPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    );
  }
}
