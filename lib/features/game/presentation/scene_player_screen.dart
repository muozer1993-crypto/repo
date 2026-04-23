import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/audio/audio_service.dart';
import '../../../core/time/clock_provider.dart';
import '../application/scene_controller.dart';
import 'widgets/completion_overlay.dart';
import 'widgets/exit_button.dart';
import 'widgets/instruction_speaker_button.dart';
import 'widgets/scene_board.dart';
import 'widgets/time_orientation_card.dart';

/// Full-screen scene player.
///
/// Flow:
///   1. TimeOrientationCard (revision #4) — shown first, blocks the
///      board until the patient identifies the time of day.
///   2. SceneBoard — tap-to-select mechanic with errorless feedback.
///   3. CompletionOverlay — shown once all targets are placed.
///
/// Exit button lives in the top-left and is always reachable, even
/// during the orientation phase. On exit the controller flushes a
/// partial SessionLog with completed=false.
class ScenePlayerScreen extends ConsumerStatefulWidget {
  const ScenePlayerScreen({super.key});

  @override
  ConsumerState<ScenePlayerScreen> createState() => _ScenePlayerScreenState();
}

class _ScenePlayerScreenState extends ConsumerState<ScenePlayerScreen> {
  bool _orientationPassed = false;

  @override
  void initState() {
    super.initState();
    // Auto-play the scene instruction once on mount.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final args = ref.read(sceneArgsProvider);
      if (args == null) return;
      ref.read(audioServiceProvider).playInstruction(
            args.scene.instructionAudioPath,
          );
    });
  }

  @override
  Widget build(BuildContext context) {
    final args = ref.watch(sceneArgsProvider);
    if (args == null) {
      return const Scaffold(
        body: Center(child: Text('Sahne bulunamadı.')),
      );
    }

    final state = ref.watch(sceneControllerProvider);
    final now = ref.watch(clockProvider)();

    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            if (!_orientationPassed)
              TimeOrientationCard(
                now: now,
                expected: args.scene.window,
                difficultyLevel: args.variant.level,
                sceneIconAsset: args.scene.backgroundAsset,
                onAnswered: ({required correct, required responseMs}) {
                  ref
                      .read(sceneControllerProvider.notifier)
                      .onOrientationAnswered(
                        correct: correct,
                        responseMs: responseMs,
                      );
                  setState(() => _orientationPassed = true);
                },
              )
            else
              const SceneBoard(),
            Positioned(
              top: 8,
              left: 8,
              child: ExitButton(onConfirmed: _onExit),
            ),
            if (_orientationPassed)
              Positioned(
                top: 8,
                right: 8,
                child: InstructionSpeakerButton(
                  instructionAudioPath: args.scene.instructionAudioPath,
                  instructionText: args.scene.instructionTr,
                ),
              ),
            if (state.isComplete)
              Positioned.fill(
                child: CompletionOverlay(onDone: _onComplete),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _onExit() => _leave(completed: false);
  Future<void> _onComplete() => _leave(completed: true);

  /// Always returns to /home, even if persisting the session log
  /// throws. The session-write failure is surfaced via debugPrint so
  /// it shows up in `flutter run` logs but never traps the patient
  /// inside the scene.
  Future<void> _leave({required bool completed}) async {
    try {
      await ref
          .read(sceneControllerProvider.notifier)
          .flushSession(completed: completed);
    } catch (e, st) {
      debugPrint('flushSession failed (continuing to home): $e\n$st');
    }
    if (!mounted) return;
    // go_router routes do not respond to Navigator.pop reliably from
    // a dialog/overlay context; use the declarative router API.
    context.go('/home');
  }
}
