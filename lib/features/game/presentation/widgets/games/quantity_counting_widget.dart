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

/// v2 Game-2 type 3 — "Kaç Tane Var?".
///
/// Shows N copies of a single item from itemPool (N ∈ 2..5, derived
/// from session's difficulty level) and four number buttons. Patient
/// taps the button matching the displayed count. One correct tap
/// completes the play.
///
/// Errorless: wrong number buttons wobble silently; correct button
/// glows green + plays correct_soft.wav.
class QuantityCountingWidget extends ConsumerStatefulWidget {
  const QuantityCountingWidget({super.key});

  @override
  ConsumerState<QuantityCountingWidget> createState() =>
      _QuantityCountingWidgetState();
}

class _QuantityCountingWidgetState
    extends ConsumerState<QuantityCountingWidget> {
  late final DateTime _sessionStart;
  DateTime? _lastTapAt;
  late final ItemPoolEntry _item;
  late final int _count;
  late final List<int> _options;

  int _errorCount = 0;
  int? _wobbleOption;
  int? _glowOption;
  bool _completed = false;
  final List<PlacementEvent> _placements = [];

  @override
  void initState() {
    super.initState();
    final session = ref.read(gameSessionControllerProvider);
    _sessionStart = ref.read(clockProvider)();
    final rng = Random(session.sessionId.hashCode);
    final targets = session.scene.itemPool.where((e) => e.isTarget).toList();
    _item = targets[rng.nextInt(targets.length)];

    // Count scales with difficulty: level 0-1 → 2-3, level 2-3 → 3-4,
    // level 4 → 4-5.
    final minC = 2 + (session.variant.level ~/ 2);
    final maxC = minC + 1;
    _count = minC + rng.nextInt(maxC - minC + 1);

    // Four number options: the real count + three neighbours. Ensure
    // count is always included and the range is 1..6.
    final base = {_count, _count - 1, _count + 1, _count + 2}
      ..removeWhere((n) => n < 1 || n > 6);
    while (base.length < 4) {
      base.add(base.first + base.length);
    }
    _options = base.take(4).toList()..sort();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            session.scene.game2!.instructionAudioPath,
          );
    });
  }

  void _onTap(int option) {
    if (_completed) return;
    final now = ref.read(clockProvider)();
    final correct = option == _count;

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
        itemId: 'quantity_$option',
        targetSlotId: 'quantity_$_count',
        outcome: correct ? Game2Outcome.correct : Game2Outcome.wrong,
        tappedDistractor: !correct,
        sessionStart: _sessionStart,
        lastTapAt: _lastTapAt,
        now: now,
        itemCountOnScreen: _options.length,
      ),
    );
    _lastTapAt = now;

    if (correct) {
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(hapticsServiceProvider).light();
      setState(() {
        _glowOption = option;
        _completed = true;
      });
      Future.delayed(const Duration(milliseconds: 700), _emitResult);
    } else {
      setState(() {
        _errorCount += 1;
        _wobbleOption = option;
      });
      final wobble = pickMotion(
        full: MotionDurations.wobble,
        reduced: MotionDurations.wobbleReduced,
        isReduced: ref.read(reducedMotionProvider),
      );
      Future.delayed(wobble + const Duration(milliseconds: 50), () {
        if (!mounted) return;
        setState(() => _wobbleOption = null);
      });
    }
  }

  void _emitResult() {
    if (!mounted) return;
    ref.read(gameSessionControllerProvider.notifier).onGame2Result(
          Game2Result(
            type: Game2Type.quantityCounting,
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
            // tight kicks in earlier (<560) so even mid-size landscape
            // phones use compact tiles + small fonts.
            final tight = c.maxHeight < 560;
            final extraTight = c.maxHeight < 420;
            return SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: 16,
                vertical: tight ? 8 : 24,
              ),
              child: Column(
                children: [
                  AutoSizeText(
                    StringsTr.game2QuantityCountingTitle,
                    style: Theme.of(context).textTheme.headlineSmall,
                    maxLines: 1,
                    minFontSize: 16,
                    wrapWords: false,
                  ),
                  const SizedBox(height: 4),
                  AutoSizeText(
                    game2.instructionTr,
                    style: Theme.of(context).textTheme.bodyMedium,
                    maxLines: 2,
                    minFontSize: 12,
                    wrapWords: false,
                    textAlign: TextAlign.center,
                  ),
                  SizedBox(height: tight ? 8 : 20),
                  _CountDisplay(
                    item: _item,
                    count: _count,
                    tight: tight,
                    extraTight: extraTight,
                  ),
                  SizedBox(height: tight ? 12 : 24),
                  Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    alignment: WrapAlignment.center,
                    children: [
                      for (final opt in _options)
                        _NumberButton(
                          value: opt,
                          wobbling: _wobbleOption == opt,
                          glowing: _glowOption == opt,
                          onTap: () => _onTap(opt),
                          tight: tight,
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                ],
              ),
            );
          },
        ),
      ),
    );
  }
}

class _CountDisplay extends StatelessWidget {
  const _CountDisplay({
    required this.item,
    required this.count,
    required this.tight,
    required this.extraTight,
  });
  final ItemPoolEntry item;
  final int count;
  final bool tight;
  final bool extraTight;

  @override
  Widget build(BuildContext context) {
    final tile = extraTight ? 48.0 : (tight ? 64.0 : 96.0);
    return Center(
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.center,
        children: [
          for (int i = 0; i < count; i++)
            Container(
              width: tile,
              height: tile,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.slotOutline, width: 2),
              ),
              clipBehavior: Clip.hardEdge,
              child: Image.asset(
                item.assetPath,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => Padding(
                  padding: const EdgeInsets.all(4),
                  child: Center(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        item.labelTr,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: extraTight ? 9 : 11,
                          height: 1.1,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _NumberButton extends StatefulWidget {
  const _NumberButton({
    required this.value,
    required this.wobbling,
    required this.glowing,
    required this.onTap,
    required this.tight,
  });

  final int value;
  final bool wobbling;
  final bool glowing;
  final VoidCallback onTap;
  final bool tight;

  @override
  State<_NumberButton> createState() => _NumberButtonState();
}

class _NumberButtonState extends State<_NumberButton>
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
  void didUpdateWidget(covariant _NumberButton old) {
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
    final size = widget.tight ? 80.0 : 120.0;
    return GestureDetector(
      onTap: widget.glowing ? null : widget.onTap,
      child: AnimatedBuilder(
        animation: _wobble,
        builder: (context, child) {
          final dx = sin(_wobble.value * pi * 4) * 6;
          return Transform.translate(offset: Offset(dx, 0), child: child);
        },
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: widget.glowing
                ? AppColors.acceptGlow.withOpacity(0.5)
                : Colors.white,
            shape: BoxShape.circle,
            border: Border.all(color: AppColors.primary, width: 3),
          ),
          alignment: Alignment.center,
          child: Text(
            '${widget.value}',
            style: (widget.tight
                    ? Theme.of(context).textTheme.headlineLarge
                    : Theme.of(context).textTheme.displayLarge)
                ?.copyWith(
              color: AppColors.primary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}
