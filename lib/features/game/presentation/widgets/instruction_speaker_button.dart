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
/// `SessionLog.instructionReplayCount`. A high replay count flags
/// working-memory strain to the therapist.
class InstructionSpeakerButton extends ConsumerWidget {
  const InstructionSpeakerButton({
    required this.instructionAudioPath,
    super.key,
  });

  final String instructionAudioPath;

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
