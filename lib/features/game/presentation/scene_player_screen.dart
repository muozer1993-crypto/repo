import 'dart:io' show Platform;

import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/audio/audio_service.dart';
import '../../../core/platform/app_exit.dart';
import '../../../core/storage/isar_db.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../../l10n/strings_tr.dart';
import '../../../shared/widgets/big_button.dart';
import '../../profile/data/profile_repository.dart';
import '../../progress/application/post_session_bonus.dart';
import '../../progress/domain/bonus_play_event.dart';
import '../application/game_session_controller.dart';
import '../application/scene_controller.dart';
import '../data/scene_repository.dart';
import '../domain/scene.dart';
import 'widgets/bonus/bonus_common.dart';
import 'widgets/bonus/find_item_widget.dart';
import 'widgets/bonus/free_explore_widget.dart';
import 'widgets/bonus/pair_match_widget.dart';
import 'widgets/bonus/tap_sequence_widget.dart';
import 'widgets/completion_overlay.dart';
import 'widgets/exit_button.dart';
import 'widgets/games/next_step_planning_widget.dart';
import 'widgets/games/plate_matching_widget.dart';
import 'widgets/games/quantity_counting_widget.dart';
import 'widgets/games/sequence_ordering_widget.dart';
import 'widgets/instruction_speaker_button.dart';
import 'widgets/scene_board.dart';
import 'widgets/time_orientation_card.dart';
import 'widgets/transition_screen.dart';

/// v2 — full session player. Hosts the whole orientation → game1 →
/// transition → game2 → completion → bonusOffer → done lifecycle.
///
/// The top-level state machine lives in [GameSessionController]; this
/// widget is a thin phase router that mounts the right sub-view.
/// Game-1 is still driven by [SceneController]; when it completes we
/// hand off the captured placements to [GameSessionController] so the
/// whole session flushes in one Isar transaction.
class ScenePlayerScreen extends ConsumerStatefulWidget {
  const ScenePlayerScreen({super.key});

  @override
  ConsumerState<ScenePlayerScreen> createState() => _ScenePlayerScreenState();
}

class _ScenePlayerScreenState extends ConsumerState<ScenePlayerScreen> {
  bool _game1Completed = false;

  @override
  Widget build(BuildContext context) {
    // Ref.listen must live inside build.
    ref.listen<SceneState>(sceneControllerProvider, (prev, next) {
      if (!_game1Completed && next.isComplete) {
        _game1Completed = true;
        _handOffGame1();
      }
    });

    // Navigate home when the session enters its terminal phase. We
    // invalidate the post-session bonus provider so the home screen's
    // BonusOfferTile re-evaluates against the freshly-flushed Today
    // snapshot — without this, the offer would only appear after a
    // full app restart.
    ref.listen<GameSessionState>(gameSessionControllerProvider,
        (prev, next) async {
      if (next.phase == GameSessionPhase.done && prev?.phase != next.phase) {
        if (!mounted) return;
        ref.invalidate(postSessionBonusAvailableProvider);
        context.go('/home');
      }
    });

    final args = ref.watch(sceneArgsProvider);
    if (args == null) {
      return const Scaffold(
        body: Center(child: Text('Sahne bulunamadı.')),
      );
    }

    final session = ref.watch(gameSessionControllerProvider);
    switch (session.phase) {
      case GameSessionPhase.orientation:
        return _OrientationPhase(args: args);
      case GameSessionPhase.game1:
        return _Game1Phase(args: args);
      case GameSessionPhase.transitionToGame2:
        return const TransitionScreen();
      case GameSessionPhase.game2:
        return _Game2PhaseFor(args.scene);
      case GameSessionPhase.completed:
        // v2 — completed phase is unreachable now (game1/game2 result
        // handlers funnel directly to farewell). Keep a compact
        // fallback in case any pre-v2 state lands here.
        return _FarewellPhase(window: args.scene.window, celebrate: true);
      case GameSessionPhase.bonusOffer:
        return _BonusOfferPhase(
          onAccept: _onBonusAccept,
          onDecline: () => ref
              .read(gameSessionControllerProvider.notifier)
              .onBonusDeclined(),
        );
      case GameSessionPhase.bonus:
        return _BonusPhase(
          onFinished: (_) => ref
              .read(gameSessionControllerProvider.notifier)
              .onBonusFinished(),
        );
      case GameSessionPhase.farewell:
        return _FarewellPhase(
          window: session.scene.window,
          celebrate: session.game1Completed &&
              (session.scene.game2 == null || session.game2Completed),
        );
      case GameSessionPhase.done:
        return const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        );
    }
  }

  Future<void> _handOffGame1() async {
    final sceneCtrl = ref.read(sceneControllerProvider.notifier);
    final sessionCtrl = ref.read(gameSessionControllerProvider.notifier);
    for (final p in sceneCtrl.placements) {
      sessionCtrl.recordGame1Placement(p);
    }
    sessionCtrl.onGame1Completed(
      errorCount: sceneCtrl.state.errorCount,
      completed: true,
    );
  }

  Future<void> _onCompletionDone() async {
    final sessionCtrl = ref.read(gameSessionControllerProvider.notifier);
    try {
      await sessionCtrl.finishAndFlush(exitedEarly: false);
    } catch (e, st) {
      debugPrint('finishAndFlush failed (continuing): $e\n$st');
      // fall through to home anyway; sync will retry.
    }
    if (!mounted) return;
    final newPhase = ref.read(gameSessionControllerProvider).phase;
    if (newPhase == GameSessionPhase.done) {
      context.go('/home');
    }
    // If phase is bonusOffer, the listener + phase render takes over.
  }

  Future<void> _onBonusAccept() async {
    final session = ref.read(gameSessionControllerProvider);
    if (session.bonusSceneId == null) return;
    ref.read(gameSessionControllerProvider.notifier).onBonusAccepted();
  }
}

// ===========================================================================
// Phase widgets.
// ===========================================================================

class _OrientationPhase extends ConsumerWidget {
  const _OrientationPhase({required this.args});
  final SceneArgs args;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = ref.watch(clockProvider)();
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            TimeOrientationCard(
              now: now,
              expected: args.scene.window,
              difficultyLevel: args.variant.level,
              sceneIconAsset: args.scene.backgroundAsset,
              onAnswered: ({required correct, required responseMs}) {
                ref
                    .read(gameSessionControllerProvider.notifier)
                    .onOrientationAnswered(
                      correct: correct,
                      responseMs: responseMs,
                    );
              },
            ),
            Positioned(
              top: 8,
              left: 8,
              child: ExitButton(onConfirmed: () => _exitApp(context)),
            ),
          ],
        ),
      ),
    );
  }

  void _exitApp(BuildContext context) {
    hardExitApp();
  }
}

class _Game1Phase extends ConsumerStatefulWidget {
  const _Game1Phase({required this.args});
  final SceneArgs args;

  @override
  ConsumerState<_Game1Phase> createState() => _Game1PhaseState();
}

class _Game1PhaseState extends ConsumerState<_Game1Phase> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(audioServiceProvider).playInstruction(
            widget.args.scene.instructionAudioPath,
          );
    });
  }

  @override
  Widget build(BuildContext context) {
    final args = widget.args;
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            const SceneBoard(),
            Positioned(
              top: 8,
              left: 8,
              child: ExitButton(onConfirmed: _onExitApp),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: InstructionSpeakerButton(
                instructionAudioPath: args.scene.instructionAudioPath,
                instructionText: args.scene.instructionTr,
              ),
            ),
            Positioned(
              top: 10,
              left: 96,
              right: 96,
              height: 80,
              child: _InstructionBanner(text: args.scene.instructionTr),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _onExitApp() async {
    // Çık during a game phase = direct exit. No farewell screen, no
    // TransitionScreen flash; flush what's captured then close the
    // app fully (incl. removing from Recents on Android via the
    // platform channel).
    final sceneCtrl = ref.read(sceneControllerProvider.notifier);
    final sessionCtrl = ref.read(gameSessionControllerProvider.notifier);
    for (final p in sceneCtrl.placements) {
      sessionCtrl.recordGame1Placement(p);
    }
    sessionCtrl.recordGame1StatsNoTransition(
      errorCount: sceneCtrl.state.errorCount,
      completed: false,
    );
    try {
      await sessionCtrl.finishAndFlush(exitedEarly: true);
    } catch (_) {
      // best-effort, never blocks the exit.
    }
    await hardExitApp();
  }
}

Widget _Game2PhaseFor(Scene scene) {
  final g2 = scene.game2;
  if (g2 == null) return const _CompletionPhase();
  switch (g2.type) {
    case Game2Type.plateMatching:
      return const PlateMatchingWidget();
    case Game2Type.sequenceOrdering:
      return const SequenceOrderingWidget();
    case Game2Type.quantityCounting:
      return const QuantityCountingWidget();
    case Game2Type.nextStepPlanning:
      return const NextStepPlanningWidget();
  }
}

class _CompletionPhase extends ConsumerWidget {
  const _CompletionPhase({this.onDone});
  final Future<void> Function()? onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: SafeArea(
        child: CompletionOverlay(
          onDone: () async {
            if (onDone != null) {
              await onDone!();
            } else {
              ref
                  .read(gameSessionControllerProvider.notifier)
                  .onBonusDeclined(); // skip offer path
            }
          },
        ),
      ),
    );
  }
}

class _BonusOfferPhase extends StatelessWidget {
  const _BonusOfferPhase({required this.onAccept, required this.onDecline});
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AutoSizeText(
                StringsTr.bonusOfferTitle,
                style: Theme.of(context).textTheme.displaySmall,
                maxLines: 2,
                minFontSize: 24,
              ),
              const SizedBox(height: 24),
              AutoSizeText(
                StringsTr.bonusOfferBody,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
                maxLines: 4,
                minFontSize: 18,
              ),
              const SizedBox(height: 48),
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Flexible(
                    child: BigButton(
                      label: StringsTr.bonusOfferDecline,
                      variant: BigButtonVariant.warning,
                      onPressed: onDecline,
                    ),
                  ),
                  const SizedBox(width: 16),
                  Flexible(
                    child: BigButton(
                      label: StringsTr.bonusOfferAccept,
                      icon: Icons.favorite_rounded,
                      variant: BigButtonVariant.accept,
                      onPressed: onAccept,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BonusPhase extends ConsumerWidget {
  const _BonusPhase({required this.onFinished});
  final BonusPlayResultCallback onFinished;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _InlineBonusHost(onFinished: onFinished);
  }
}

class _InlineBonusHost extends ConsumerStatefulWidget {
  const _InlineBonusHost({required this.onFinished});
  final BonusPlayResultCallback onFinished;

  @override
  ConsumerState<_InlineBonusHost> createState() => _InlineBonusHostState();
}

class _InlineBonusHostState extends ConsumerState<_InlineBonusHost> {
  BonusScene? _scene;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final session = ref.read(gameSessionControllerProvider);
    final id = session.bonusSceneId;
    if (id == null) return;
    final repo = ref.read(sceneRepositoryProvider);
    final s = await repo.bonusById(id);
    if (!mounted) return;
    setState(() => _scene = s);
  }

  Future<void> _onFinished(BonusPlayResult r) async {
    await _writeBonus(r);
    widget.onFinished(r);
  }

  Future<void> _writeBonus(BonusPlayResult r) async {
    final profile = ref.read(patientProfileProvider).value;
    if (profile == null) return;
    final now = ref.read(clockProvider)();
    final tw = windowFor(now);
    // ignore: avoid_dynamic_calls
    await ref.read(isarProvider).writeTxn(() async {
      // ignore: avoid_dynamic_calls
      await ref.read(isarProvider).bonusPlayEvents.put(
            (BonusPlayEvent()
              ..bonusPlayId = DateTime.now().microsecondsSinceEpoch.toString()
              ..profileId = profile.profileId
              ..bonusSceneId = r.bonusSceneId
              ..bonusType = bonusTypeId(r.bonusType)
              ..startedAt = now.subtract(const Duration(seconds: 1))
              ..finishedAt = r.finishedAt
              ..tapCount = r.tapCount
              ..nightBonus = false
              ..timeWindow = timeWindowId(tw)),
          );
    });
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scene;
    if (scene == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    switch (scene.bonusType) {
      case BonusType.findItem:
        return FindItemWidget(bonusScene: scene, onFinished: _onFinished);
      case BonusType.tapSequence:
        return TapSequenceWidget(bonusScene: scene, onFinished: _onFinished);
      case BonusType.pairMatch:
        return PairMatchWidget(bonusScene: scene, onFinished: _onFinished);
      case BonusType.freeExplore:
        return FreeExploreWidget(bonusScene: scene, onFinished: _onFinished);
    }
  }
}

/// v2 — early-stop terminal screen. Shown after either:
///   * the patient hits Çık during a game phase, or
///   * the patient taps "Şimdilik yeterli" on the transition screen.
///
/// Renders a context-aware "Görüşürüz" message (Sabah → "Öğle vakti
/// görüşürüz", Akşam → "Yarın sabah görüşürüz", etc.) and a single
/// Çık button that *actually* closes the app (force-exits the
/// process via dart:io exit(0); SystemNavigator.pop() on some Android
/// OEM builds just minimises).
class _FarewellPhase extends StatelessWidget {
  const _FarewellPhase({
    required this.window,
    required this.celebrate,
  });
  final TimeWindow window;

  /// True when the patient finished both games (or game1 only on
  /// game2-less scenes). Drives the "Aferin harikasın!" mini-header
  /// and the green check icon. False on early-stop paths (Çık,
  /// Şimdilik yeterli) so the screen feels neutral, not celebratory.
  final bool celebrate;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, c) {
            final isTight = c.maxHeight < 480;
            return SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: 32,
                vertical: isTight ? 16 : 32,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: c.maxHeight - 16),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (celebrate) ...[
                      Icon(
                        Icons.check_circle_rounded,
                        size: isTight ? 56 : 88,
                        color: AppColors.acceptGlow,
                      ),
                      const SizedBox(height: 8),
                      AutoSizeText(
                        StringsTr.completionTitle,
                        maxLines: 1,
                        minFontSize: 18,
                        wrapWords: false,
                        textAlign: TextAlign.center,
                        style: t.headlineSmall?.copyWith(
                          color: AppColors.primary,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      SizedBox(height: isTight ? 12 : 24),
                    ] else ...[
                      Icon(
                        Icons.waving_hand_rounded,
                        size: isTight ? 56 : 88,
                        color: AppColors.primary,
                      ),
                      SizedBox(height: isTight ? 12 : 24),
                    ],
                    AutoSizeText(
                      _farewellTitle(window),
                      style: t.displaySmall?.copyWith(
                        color: AppColors.primaryDark,
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 2,
                      minFontSize: 18,
                      wrapWords: false,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'İyi günler — sonra görüşmek üzere.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 16,
                        color: AppColors.textSecondary,
                      ),
                    ),
                    SizedBox(height: isTight ? 20 : 40),
                    SizedBox(
                      width: double.infinity,
                      child: BigButton(
                        label: 'Çık',
                        icon: Icons.logout_rounded,
                        variant: BigButtonVariant.danger,
                        expand: true,
                        compact: isTight,
                        onPressed: _hardExit,
                      ),
                    ),
                    const SizedBox(height: 8),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  static String _farewellTitle(TimeWindow w) => switch (w) {
        TimeWindow.sabah => 'Öğle vakti görüşürüz',
        TimeWindow.oglen => 'İkindi vakti görüşürüz',
        TimeWindow.ikindi => 'Akşam vakti görüşürüz',
        TimeWindow.aksam => 'Yarın sabah görüşürüz',
        TimeWindow.dinlenme => 'İyi geceler',
      };

  static Future<void> _hardExit() => hardExitApp();
}

// -- shared -----------------------------------------------------------------

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
          child: AutoSizeText(
            text,
            textAlign: TextAlign.center,
            maxLines: 3,
            minFontSize: 14,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              height: 1.2,
            ),
          ),
        ),
      ),
    );
  }
}
