import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';

/// Always-visible exit affordance (top-left of every scene).
///
/// Shows a confirmation dialog rather than exiting immediately so
/// accidental taps don't erase an in-progress session. On confirm,
/// the parent is expected to flush the partial [SessionLog] with
/// `completed=false` before popping.
class ExitButton extends StatelessWidget {
  const ExitButton({required this.onConfirmed, super.key});

  final VoidCallback onConfirmed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: StringsTr.exitButton,
      child: Material(
        color: Colors.white.withValues(alpha: 0.9),
        shape: const CircleBorder(),
        elevation: 2,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: () => _confirm(context),
          child: const Padding(
            padding: EdgeInsets.all(18),
            child: Icon(
              Icons.close_rounded,
              size: 36,
              color: AppColors.primary,
              semanticLabel: StringsTr.exitButton,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _confirm(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text(StringsTr.exitConfirmTitle),
        titleTextStyle: const TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.w600,
          color: AppColors.textPrimary,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text(
              StringsTr.exitConfirmCancel,
              style: TextStyle(fontSize: 22),
            ),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text(StringsTr.exitConfirmOk),
          ),
        ],
      ),
    );
    if (confirmed == true) onConfirmed();
  }
}
