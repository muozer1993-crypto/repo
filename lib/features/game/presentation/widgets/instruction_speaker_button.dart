import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/audio/audio_service.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../../../shared/widgets/labeled_icon_button.dart';
import '../../application/scene_controller.dart';

/// Clinical revision #6 — a top-right button the patient can tap at any
/// time to hear the scene's instruction again.
///
/// Each tap plays the instruction audio and increments
/// `SessionLog.instructionReplayCount`. Also shows a floating SnackBar
/// with the instruction text so the button is useful even when audio
/// assets are not yet bundled.
class InstructionSpeakerButton extends ConsumerWidget {
  const InstructionSpeakerButton({
    required this.instructionAudioPath,
    required this.instructionText,
    super.key,
  });

  final String instructionAudioPath;
  final String instructionText;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return LabeledIconButton(
      label: 'Dinle',
      icon: Icons.volume_up_rounded,
      tooltip: StringsTr.speakerButtonLabel,
      onTap: () {
        ref
            .read(audioServiceProvider)
            .playInstruction(instructionAudioPath);
        ref
            .read(sceneControllerProvider.notifier)
            .onInstructionReplayed();
        final messenger = ScaffoldMessenger.of(context);
        messenger.clearSnackBars();
        messenger.showSnackBar(
          SnackBar(
            content: Text(
              instructionText,
              style: const TextStyle(fontSize: 22),
            ),
            duration: const Duration(seconds: 5),
            behavior: SnackBarBehavior.floating,
            backgroundColor: AppColors.primary,
          ),
        );
      },
    );
  }
}
