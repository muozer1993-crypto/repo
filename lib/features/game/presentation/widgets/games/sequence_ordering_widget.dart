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

/// v2 Game-2 type 2 — "Sırayı Düzene Koy".
///
/// Four cards (all targets from itemPool) must be tapped in the
/// correct order — e.g. lunch-sofra = çorba → ana yemek → salata → su.
/// Out-of-order taps wobble; the card stays in place. Correct taps
/// advance the sequence counter with a soft glow.
///
/// Completion: all four cards tapped in order. Since the order is
/// scene-dependent (itemPool order implies canonical sequence), the
/// first four targets in the pool drive the expected order. Future
/// revisions may allow multiple valid orders, but v2 keeps it single.
class SequenceOrderingWidget extends ConsumerStatefulWidget {
  const SequenceOrderingWidget({super.key});

  @override
  ConsumerState<SequenceOrderingWidget> createState() =>
      _SequenceOrderingWidgetState();
}

class _SequenceOrderingWidgetState
    extends ConsumerState<SequenceOrderingWidget> {
  late final DateTime _sessionStart;
  DateTime? _lastTapAt;
  late final List<ItemPoolEntry> _orderedTargets;
  late final List<ItemPoolEntry> _displayItems;

  int _errorCount = 0;
  int _sequenceCursor = 0;
  String? _wobbleItemId;
  final Set<String> _placedIds = {};
  final List<PlacementEvent> _placements = [];
  bool _emitted = false;

  @override
  void initState() {
    super.initState();
    _sessionStart = ref.read(clockProvider)();
    final session = ref.read(gameSessionControllerProvider);
    final targets =
        session.scene.itemPool.where((e) => e.isTarget).take(4).toList();
    _orderedTargets = List.unmodifiable(targets);
    _displayItems = List.of(targets)..shuffle(Random(session.sessionId.hashCode));

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            session.scene.game2!.instructionAudioPath,
          );
    });
  }

  void _onTap(ItemPoolEntry entry) {
    if (_emitted) return;
    if (_placedIds.contains(entry.id)) return;

    final now = ref.read(clockProvider)();
    final expectedId = _orderedTargets[_sequenceCursor].id;
    final correct = entry.id == expectedId;

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
        targetSlotId: expectedId,
        outcome: correct ? Game2Outcome.correct : Game2Outcome.wrong,
        tappedDistractor: false,
        sessionStart: _sessionStart,
        lastTapAt: _lastTapAt,
        now: now,
        itemCountOnScreen: _displayItems.length,
      ),
    );
    _lastTapAt = now;

    if (correct) {
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(hapticsServiceProvider).light();
      setState(() {
        _placedIds.add(entry.id);
        _sequenceCursor += 1;
      });
      if (_sequenceCursor >= _orderedTargets.length) {
        _emitted = true;
        Future.delayed(const Duration(milliseconds: 400), _emitResult);
      }
    } else {
      setState(() {
        _errorCount += 1;
        _wobbleItemId = entry.id;
      });
      final wobble = pickMotion(
        full: MotionDurations.wobble,
        reduced: MotionDurations.wobbleReduced,
        isReduced: ref.read(reducedMotionProvider),
      );
      Future.delayed(wobble + const Duration(milliseconds: 40), () {
        if (!mounted) return;
        setState(() => _wobbleItemId = null);
      });
    }
  }

  void _emitResult() {
    if (!mounted) return;
    ref.read(gameSessionControllerProvider.notifier).onGame2Result(
          Game2Result(
            type: Game2Type.sequenceOrdering,
            errorCount: _errorCount,
            completed: _placedIds.length == _orderedTargets.length,
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
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            children: [
              AutoSizeText(
                StringsTr.game2SequenceOrderingTitle,
                style: Theme.of(context).textTheme.displaySmall,
                maxLines: 1,
                minFontSize: 24,
              ),
              const SizedBox(height: 8),
              AutoSizeText(
                game2.instructionTr,
                style: Theme.of(context).textTheme.bodyLarge,
                maxLines: 3,
                minFontSize: 18,
              ),
              const SizedBox(height: 24),
              _ProgressBar(
                total: _orderedTargets.length,
                placed: _sequenceCursor,
              ),
              const SizedBox(height: 24),
              Expanded(
                child: Center(
                  child: Wrap(
                    spacing: 24,
                    runSpacing: 16,
                    alignment: WrapAlignment.center,
                    children: [
                      for (final item in _displayItems)
                        _SequenceCard(
                          item: item,
                          placed: _placedIds.contains(item.id),
                          wobbling: _wobbleItemId == item.id,
                          orderIndex: _orderIndexOf(item),
                          onTap: () => _onTap(item),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  int? _orderIndexOf(ItemPoolEntry item) {
    if (!_placedIds.contains(item.id)) return null;
    final idx = _orderedTargets.indexWhere((e) => e.id == item.id);
    return idx < 0 ? null : idx + 1;
  }
}

class _ProgressBar extends StatelessWidget {
  const _ProgressBar({required this.total, required this.placed});
  final int total;
  final int placed;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (int i = 0; i < total; i++)
          Container(
            width: 48,
            height: 12,
            margin: const EdgeInsets.symmetric(horizontal: 4),
            decoration: BoxDecoration(
              color: i < placed
                  ? AppColors.acceptGlow
                  : AppColors.slotOutline.withOpacity(0.3),
              borderRadius: BorderRadius.circular(6),
            ),
          ),
      ],
    );
  }
}

class _SequenceCard extends StatefulWidget {
  const _SequenceCard({
    required this.item,
    required this.placed,
    required this.wobbling,
    required this.orderIndex,
    required this.onTap,
  });

  final ItemPoolEntry item;
  final bool placed;
  final bool wobbling;
  final int? orderIndex;
  final VoidCallback onTap;

  @override
  State<_SequenceCard> createState() => _SequenceCardState();
}

class _SequenceCardState extends State<_SequenceCard>
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
  void didUpdateWidget(covariant _SequenceCard old) {
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
      onTap: widget.placed ? null : widget.onTap,
      child: AnimatedBuilder(
        animation: _wobble,
        builder: (context, child) {
          final dx = sin(_wobble.value * pi * 4) * 6;
          return Transform.translate(offset: Offset(dx, 0), child: child);
        },
        child: Container(
          width: 160,
          height: 140,
          decoration: BoxDecoration(
            color: widget.placed
                ? AppColors.acceptGlow.withOpacity(0.4)
                : Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.primary, width: 2),
          ),
          alignment: Alignment.center,
          padding: const EdgeInsets.all(12),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (widget.orderIndex != null)
                Text(
                  '${widget.orderIndex}',
                  style: Theme.of(context)
                      .textTheme
                      .displaySmall
                      ?.copyWith(color: AppColors.primary),
                ),
              AutoSizeText(
                widget.item.labelTr,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
                maxLines: 2,
                minFontSize: 14,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
