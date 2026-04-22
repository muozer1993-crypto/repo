import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// Primary CTA used across the app.
///
/// Enforces the minimum 64dp touch target and large readable label. Prefer
/// this over raw [ElevatedButton] so we do not accidentally undershoot the
/// accessibility baseline in one-off buttons.
class BigButton extends StatelessWidget {
  const BigButton({
    required this.label,
    required this.onPressed,
    this.icon,
    this.expand = false,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  /// If true, stretches to fill the parent's width.
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final button = ElevatedButton(
      onPressed: onPressed,
      style: ElevatedButton.styleFrom(
        minimumSize: Size(
          expand ? double.infinity : AppTheme.minTouchTarget,
          AppTheme.minTouchTarget,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 24),
      ),
      child: Row(
        mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 32),
            const SizedBox(width: 16),
          ],
          Text(label),
        ],
      ),
    );

    return expand ? SizedBox(width: double.infinity, child: button) : button;
  }
}
