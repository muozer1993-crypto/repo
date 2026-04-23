import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../../../shared/widgets/labeled_icon_button.dart';

/// Top-left "Çık" affordance on every scene.
///
/// Shows an icon + a visible label below it so elderly users don't
/// have to guess what an X-in-a-circle means. Confirmation dialog
/// protects against accidental mid-session taps.
class ExitButton extends StatelessWidget {
  const ExitButton({required this.onConfirmed, super.key});

  final VoidCallback onConfirmed;

  @override
  Widget build(BuildContext context) {
    return LabeledIconButton(
      label: 'Çık',
      icon: Icons.close_rounded,
      tooltip: StringsTr.exitButton,
      onTap: () => _confirm(context),
    );
  }

  Future<void> _confirm(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text(StringsTr.exitConfirmTitle),
        titleTextStyle: const TextStyle(
          fontSize: 26,
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
