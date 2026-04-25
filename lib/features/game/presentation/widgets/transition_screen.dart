import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/audio/audio_service.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../../../shared/widgets/big_button.dart';
import '../../application/game_session_controller.dart';

/// v2 — "Aferin! Şimdi ikinci oyuna geçelim" bridge between Game-1 and
/// Game-2.
///
/// Rendered when [GameSessionState.phase] is
/// [GameSessionPhase.transitionToGame2]. Reads the scene's
/// [Game2Config.instructionTr] so the patient hears a soft preview of
/// the next challenge, plays the Game-2 instruction audio once, and
/// exposes two buttons:
///   * "Devam" → onTransitionContinue() → game2 phase.
///   * "Şimdilik yeterli" → onTransitionSkipGame2() → completed phase.
class TransitionScreen extends ConsumerStatefulWidget {
  const TransitionScreen({super.key});

  @override
  ConsumerState<TransitionScreen> createState() => _TransitionScreenState();
}

class _TransitionScreenState extends ConsumerState<TransitionScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final scene = ref.read(gameSessionControllerProvider).scene;
      final g2 = scene.game2;
      if (g2 == null) return;
      ref.read(audioServiceProvider).playInstruction(g2.instructionAudioPath);
    });
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(gameSessionControllerProvider);
    final game2 = session.scene.game2;
    if (game2 == null) {
      return _FallbackContinue();
    }

    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 32),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: MediaQuery.of(context).size.height -
                  MediaQuery.of(context).padding.vertical -
                  64,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 24),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: AutoSizeText(
                    StringsTr.transitionHeadline,
                    style: Theme.of(context)
                        .textTheme
                        .displaySmall
                        ?.copyWith(color: AppColors.primary),
                    maxLines: 3,
                    minFontSize: 20,
                    wrapWords: false,
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 24),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 720),
                  child: AutoSizeText(
                    game2.instructionTr,
                    style: Theme.of(context).textTheme.bodyLarge,
                    maxLines: 5,
                    minFontSize: 14,
                    wrapWords: false,
                    textAlign: TextAlign.center,
                  ),
                ),
                const SizedBox(height: 40),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Expanded(
                      child: BigButton(
                        label: StringsTr.transitionSkip,
                        icon: Icons.pause_rounded,
                        variant: BigButtonVariant.warning,
                        onPressed: () => ref
                            .read(gameSessionControllerProvider.notifier)
                            .onTransitionSkipGame2(),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: BigButton(
                        label: StringsTr.transitionContinue,
                        icon: Icons.arrow_forward_rounded,
                        variant: BigButtonVariant.primary,
                        onPressed: () => ref
                            .read(gameSessionControllerProvider.notifier)
                            .onTransitionContinue(),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _FallbackContinue extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: BigButton(
          label: StringsTr.transitionContinue,
          onPressed: () => ref
              .read(gameSessionControllerProvider.notifier)
              .onTransitionContinue(),
        ),
      ),
    );
  }
}
