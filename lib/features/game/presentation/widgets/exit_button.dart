import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../../../shared/widgets/big_button.dart';
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
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        title: const Text(StringsTr.exitConfirmTitle),
        titleTextStyle: const TextStyle(
          fontSize: 24,
          fontWeight: FontWeight.w600,
          color: AppColors.textPrimary,
        ),
        // Stack actions vertically so on phone widths neither button
        // shrinks. AlertDialog will lay them out per actionsAlignment;
        // we override with a Column inside `content` and pass empty
        // actions to suppress the default action row.
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            BigButton(
              label: StringsTr.exitConfirmCancel,
              icon: Icons.arrow_back_rounded,
              variant: BigButtonVariant.primary,
              expand: true,
              compact: true,
              onPressed: () => Navigator.of(context).pop(false),
            ),
            const SizedBox(height: 12),
            BigButton(
              label: StringsTr.exitConfirmOk,
              icon: Icons.logout_rounded,
              variant: BigButtonVariant.danger,
              expand: true,
              compact: true,
              onPressed: () => Navigator.of(context).pop(true),
            ),
          ],
        ),
        actionsPadding: EdgeInsets.zero,
        actions: const [],
      ),
    );
    if (confirmed == true) onConfirmed();
  }
}
