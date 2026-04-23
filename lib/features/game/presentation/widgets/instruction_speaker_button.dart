import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/audio/audio_service.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../application/scene_controller.dart';

/// Clinical revision #6 — a top-right button the patient can tap at any
/// time to hear the scene's instruction again.
///
/// Each tap plays the instruction audio and increments
/// `SessionLog.instructionReplayCount`. When audio assets are not yet
/// bundled (dev / early preview), a caption-style SnackBar with the
/// instruction text serves as a visible fallback so the button still
/// gives meaningful feedback.
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
    return Tooltip(
      message: StringsTr.speakerButtonLabel,
      child: Material(
        color: Colors.white.withValues(alpha: 0.9),
        shape: const CircleBorder(),
        elevation: 2,
        child: InkWell(
          customBorder: const CircleBorder(),
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
          child: const Padding(
            padding: EdgeInsets.all(16),
            child: Icon(
              Icons.volume_up_rounded,
              size: 32,
              color: AppColors.primary,
              semanticLabel: StringsTr.speakerButtonLabel,
            ),
          ),
        ),
      ),
    );
  }
}
