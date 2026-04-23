import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// Round icon with a visible text label below it.
///
/// Used on the home screen and inside the scene player so elderly
/// users see what each button does instead of guessing from icon
/// conventions. Minimum total touch target height is ~72dp
/// (circle + caption), safely above the accessibility baseline.
class LabeledIconButton extends StatelessWidget {
  const LabeledIconButton({
    required this.label,
    required this.icon,
    required this.onTap,
    this.tooltip,
    super.key,
  });

  final String label;
  final IconData icon;
  final VoidCallback onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final child = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: Colors.white.withValues(alpha: 0.95),
          shape: const CircleBorder(),
          elevation: 2,
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Icon(
                icon,
                size: 32,
                color: AppColors.primary,
                semanticLabel: tooltip ?? label,
              ),
            ),
          ),
        ),
        const SizedBox(height: 2),
        Text(
          label,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: AppColors.textPrimary,
          ),
        ),
      ],
    );
    return tooltip != null
        ? Tooltip(message: tooltip!, child: child)
        : child;
  }
}
