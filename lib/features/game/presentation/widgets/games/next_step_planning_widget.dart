import 'dart:math';

import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/audio/audio_service.dart';
import '../../../../../core/haptics/haptics_service.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../../../../core/theme/motion.dart';
import '../../../../../core/time/clock_provider.dart';
import '../../../../../l10n/strings_tr.dart';
import '../../../../progress/domain/session_log.dart';
import '../../../application/game2_common.dart';
import '../../../application/game_session_controller.dart';
import '../../../domain/scene.dart';

/// v2 Game-2 type 4 — "Sıradaki Adım".
///
/// Shows 3 action cards (all targets from itemPool), asks the patient
/// to pick the right *first* step in the ADL sequence. For v2 the
/// "first step" is the first target in [Scene.itemPool] — a simple
/// heuristic that avoids adding explicit step ordering to the JSON
/// schema until a clinical review requires it.
///
/// Errorless: wrong cards wobble; correct card glows + plays
/// correct_soft.wav. One correct tap completes the play.
class NextStepPlanningWidget extends ConsumerStatefulWidget {
  const NextStepPlanningWidget({super.key});

  @override
  ConsumerState<NextStepPlanningWidget> createState() =>
      _NextStepPlanningWidgetState();
}

class _NextStepPlanningWidgetState
    extends ConsumerState<NextStepPlanningWidget> {
  late final DateTime _sessionStart;
  DateTime? _lastTapAt;
  late final List<ItemPoolEntry> _actions;
  late final ItemPoolEntry _correctAction;

  int _errorCount = 0;
  String? _wobbleId;
  String? _glowId;
  bool _completed = false;
  final List<PlacementEvent> _placements = [];

  @override
  void initState() {
    super.initState();
    _sessionStart = ref.read(clockProvider)();
    final session = ref.read(gameSessionControllerProvider);
    final targets =
        session.scene.itemPool.where((e) => e.isTarget).toList();
    // First target is the canonical "next step"; pick 2 more as
    // distractor options.
    _correctAction = targets.first;
    final rng = Random(session.sessionId.hashCode);
    final others = targets.sublist(1)..shuffle(rng);
    _actions = [_correctAction, ...others.take(2)]..shuffle(rng);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            session.scene.game2!.instructionAudioPath,
          );
    });
  }

  void _onTap(ItemPoolEntry entry) {
    if (_completed) return;
    final now = ref.read(clockProvider)();
    final correct = entry.id == _correctAction.id;

    final session = ref.read(gameSessionControllerProvider);
    _placements.add(
      buildGame2PlacementEvent(
        deps: Game2Deps(
          config: session.scene.game2!,
          scene: session.scene,
          variant: session.variant,
          clock: ref.read(clockProvider),
          profileId: '',
          sessionId: session.sessionId,
        ),
        itemId: entry.id,
        targetSlotId: _correctAction.id,
        outcome: correct ? Game2Outcome.correct : Game2Outcome.wrong,
        tappedDistractor: !correct,
        sessionStart: _sessionStart,
        lastTapAt: _lastTapAt,
        now: now,
        itemCountOnScreen: _actions.length,
      ),
    );
    _lastTapAt = now;

    if (correct) {
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(hapticsServiceProvider).light();
      setState(() {
        _glowId = entry.id;
        _completed = true;
      });
      Future.delayed(const Duration(milliseconds: 700), _emitResult);
    } else {
      setState(() {
        _errorCount += 1;
        _wobbleId = entry.id;
      });
      final wobble = pickMotion(
        full: MotionDurations.wobble,
        reduced: MotionDurations.wobbleReduced,
        isReduced: ref.read(reducedMotionProvider),
      );
      Future.delayed(wobble + const Duration(milliseconds: 50), () {
        if (!mounted) return;
        setState(() => _wobbleId = null);
      });
    }
  }

  void _emitResult() {
    if (!mounted) return;
    ref.read(gameSessionControllerProvider.notifier).onGame2Result(
          Game2Result(
            type: Game2Type.nextStepPlanning,
            errorCount: _errorCount,
            completed: _completed,
            placements: List.of(_placements),
          ),
        );
  }

  @override
  Widget build(BuildContext context) {
    final game2 = ref.watch(gameSessionControllerProvider).scene.game2!;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, c) {
            final tight = c.maxHeight < 480;
            return SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: 24,
                vertical: tight ? 12 : 24,
              ),
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: c.maxHeight - 24),
                child: Column(
                  children: [
                    AutoSizeText(
                      StringsTr.game2NextStepPlanningTitle,
                      style: Theme.of(context).textTheme.displaySmall,
                      maxLines: 1,
                      minFontSize: 18,
                      wrapWords: false,
                    ),
                    const SizedBox(height: 6),
                    AutoSizeText(
                      game2.instructionTr,
                      style: Theme.of(context).textTheme.bodyLarge,
                      maxLines: 3,
                      minFontSize: 14,
                      wrapWords: false,
                      textAlign: TextAlign.center,
                    ),
                    SizedBox(height: tight ? 16 : 28),
                    Wrap(
                      spacing: tight ? 12 : 24,
                      runSpacing: 12,
                      alignment: WrapAlignment.center,
                      children: [
                        for (final action in _actions)
                          _ActionCard(
                            item: action,
                            wobbling: _wobbleId == action.id,
                            glowing: _glowId == action.id,
                            onTap: () => _onTap(action),
                            tight: tight,
                          ),
                      ],
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
}

class _ActionCard extends StatefulWidget {
  const _ActionCard({
    required this.item,
    required this.wobbling,
    required this.glowing,
    required this.onTap,
    this.tight = false,
  });

  final ItemPoolEntry item;
  final bool wobbling;
  final bool glowing;
  final VoidCallback onTap;
  final bool tight;

  @override
  State<_ActionCard> createState() => _ActionCardState();
}

class _ActionCardState extends State<_ActionCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _wobble;

  @override
  void initState() {
    super.initState();
    _wobble = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
    );
  }

  @override
  void didUpdateWidget(covariant _ActionCard old) {
    super.didUpdateWidget(old);
    if (widget.wobbling && !old.wobbling) _wobble.forward(from: 0);
  }

  @override
  void dispose() {
    _wobble.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: widget.glowing ? null : widget.onTap,
      child: AnimatedBuilder(
        animation: _wobble,
        builder: (context, child) {
          final dx = sin(_wobble.value * pi * 4) * 6;
          return Transform.translate(offset: Offset(dx, 0), child: child);
        },
        child: Container(
          width: widget.tight ? 130 : 180,
          height: widget.tight ? 130 : 180,
          decoration: BoxDecoration(
            color: widget.glowing
                ? AppColors.acceptGlow.withOpacity(0.5)
                : Colors.white,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AppColors.primary, width: 3),
          ),
          alignment: Alignment.center,
          padding: const EdgeInsets.all(16),
          child: AutoSizeText(
            widget.item.labelTr,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleLarge,
            maxLines: 3,
            minFontSize: 18,
          ),
        ),
      ),
    );
  }
}
