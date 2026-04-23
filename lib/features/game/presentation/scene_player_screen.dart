import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
/// Exit button ("Çık") closes the app per the caregiver's explicit
/// request that elderly users can close out from the game screen.
/// Completion ("Ana ekrana dön") returns to /home.
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
            // Top bar: Çık (left), instruction banner (center),
            // Dinle (right). The banner sits between the two buttons
            // so it doesn't consume its own row and the slots/tray
            // get more vertical space.
            Positioned(
              top: 8,
              left: 8,
              child: ExitButton(onConfirmed: _onExitApp),
            ),
            if (_orientationPassed) ...[
              Positioned(
                top: 8,
                right: 8,
                child: InstructionSpeakerButton(
                  instructionAudioPath: args.scene.instructionAudioPath,
                  instructionText: args.scene.instructionTr,
                ),
              ),
              Positioned(
                top: 12,
                left: 96,
                right: 96,
                height: 72,
                child: _InstructionBanner(text: args.scene.instructionTr),
              ),
            ],
            if (state.isComplete)
              Positioned.fill(
                child: CompletionOverlay(onDone: _onCompleteToHome),
              ),
          ],
        ),
      ),
    );
  }

  /// Scene "Çık" — flush the partial session and then close the app
  /// outright. Caregivers asked that the in-scene exit actually quit
  /// the app rather than return to the home menu.
  Future<void> _onExitApp() async {
    await _flushSafely(completed: false);
    if (!mounted) return;
    _closeApp();
  }

  /// Completion overlay "Ana ekrana dön" — persist the session and
  /// navigate to the home screen so the patient can play another one.
  Future<void> _onCompleteToHome() async {
    await _flushSafely(completed: true);
    if (!mounted) return;
    context.go('/home');
  }

  Future<void> _flushSafely({required bool completed}) async {
    try {
      await ref
          .read(sceneControllerProvider.notifier)
          .flushSession(completed: completed);
    } catch (e, st) {
      debugPrint('flushSession failed (continuing): $e\n$st');
    }
  }

  void _closeApp() {
    if (Platform.isAndroid) {
      SystemNavigator.pop();
    } else {
      // iOS: Apple HIG discourages programmatic quit. Fall back to
      // routing home so we don't ship a button that does nothing.
      context.go('/home');
    }
  }
}

/// Scene objective banner. Sits between the Çık and Dinle buttons in
/// the top bar so the objective is always readable without stealing a
/// row from the slot/tray area. FittedBox(scaleDown) shrinks long
/// instructions like "Yatmadan önce komodinini düzenle" to fit the
/// narrow horizontal band before resorting to ellipsis.
class _InstructionBanner extends StatelessWidget {
  const _InstructionBanner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Material(
      elevation: 2,
      borderRadius: BorderRadius.circular(14),
      color: Colors.white.withValues(alpha: 0.95),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Center(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              text,
              textAlign: TextAlign.center,
              maxLines: 3,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                height: 1.2,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
