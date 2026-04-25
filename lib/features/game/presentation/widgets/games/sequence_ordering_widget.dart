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
/// Layout:
///   * LEFT — shuffled tray of the four target items (mix).
///   * RIGHT — 4 numbered ordered slots ("1, 2, 3, 4").
/// Patient taps an item; if it's the next in the canonical sequence
/// (defined by the order of the first 4 itemPool targets), it flies
/// from the tray into the corresponding numbered slot. If not in
/// sequence, the tray tile wobbles silently — errorless.
///
/// In landscape both halves stretch to fill height. In portrait the
/// layout stacks vertically: tray on top, ordered slots below, so the
/// fly-from-tray-to-slot motion is still visible without overflow.
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
  late final List<ItemPoolEntry> _trayItems;

  int _errorCount = 0;
  int _sequenceCursor = 0;
  String? _wobbleItemId;
  String? _flyingItemId;
  final Set<String> _placedIds = {};
  final List<PlacementEvent> _placements = [];
  bool _emitted = false;

  // Keys for fly animation start/end positions.
  final Map<String, GlobalKey> _trayKeys = {};
  final Map<int, GlobalKey> _slotKeys = {};
  final List<_FlyState> _inFlight = [];

  @override
  void initState() {
    super.initState();
    _sessionStart = ref.read(clockProvider)();
    final session = ref.read(gameSessionControllerProvider);
    final targets =
        session.scene.itemPool.where((e) => e.isTarget).take(4).toList();
    _orderedTargets = List.unmodifiable(targets);
    _trayItems = List.of(targets)
      ..shuffle(Random(session.sessionId.hashCode));

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
    final expectedIndex = _sequenceCursor;
    final expectedId = _orderedTargets[expectedIndex].id;
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
        itemCountOnScreen: _trayItems.length,
      ),
    );
    _lastTapAt = now;

    if (correct) {
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(hapticsServiceProvider).light();
      _startFlyTo(entry, expectedIndex);
      setState(() {
        _placedIds.add(entry.id);
        _sequenceCursor += 1;
      });
      if (_sequenceCursor >= _orderedTargets.length) {
        _emitted = true;
        Future.delayed(const Duration(milliseconds: 700), _emitResult);
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

  void _startFlyTo(ItemPoolEntry entry, int slotIndex) {
    final trayBox = _trayKeys[entry.id]?.currentContext?.findRenderObject()
        as RenderBox?;
    final slotBox = _slotKeys[slotIndex]?.currentContext?.findRenderObject()
        as RenderBox?;
    if (trayBox == null || slotBox == null) return;
    final start = trayBox.localToGlobal(Offset.zero);
    final end = slotBox.localToGlobal(Offset.zero);
    final size = trayBox.size;
    final fly = _FlyState(
      key: ValueKey('fly_${entry.id}'),
      entry: entry,
      start: start,
      end: end,
      size: size,
    );
    setState(() {
      _flyingItemId = entry.id;
      _inFlight.add(fly);
    });
    Future.delayed(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      setState(() {
        _inFlight.remove(fly);
        if (_flyingItemId == entry.id) _flyingItemId = null;
      });
    });
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
        child: Stack(
          children: [
            LayoutBuilder(
              builder: (context, c) {
                final tight = c.maxHeight < 480;
                return SingleChildScrollView(
                  padding: EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: tight ? 8 : 20,
                  ),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(minHeight: c.maxHeight - 16),
                    child: Column(
                      children: [
                        AutoSizeText(
                          StringsTr.game2SequenceOrderingTitle,
                          style: Theme.of(context).textTheme.displaySmall,
                          maxLines: 1,
                          minFontSize: 18,
                          wrapWords: false,
                        ),
                        const SizedBox(height: 4),
                        AutoSizeText(
                          game2.instructionTr,
                          style: Theme.of(context).textTheme.bodyLarge,
                          maxLines: 3,
                          minFontSize: 14,
                          wrapWords: false,
                          textAlign: TextAlign.center,
                        ),
                        SizedBox(height: tight ? 12 : 20),
                        SizedBox(
                          height: tight ? 220 : 320,
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Expanded(
                                child: _TrayColumn(
                                  items: _trayItems,
                                  trayKeys: _trayKeys,
                                  placedIds: _placedIds,
                                  flyingItemId: _flyingItemId,
                                  wobbleId: _wobbleItemId,
                                  onTap: _onTap,
                                ),
                              ),
                              const SizedBox(width: 16),
                              Expanded(
                                child: _OrderColumn(
                                  ordered: _orderedTargets,
                                  slotKeys: _slotKeys,
                                  placedIds: _placedIds,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 8),
                      ],
                    ),
                  ),
                );
              },
            ),
            for (final f in _inFlight)
              _FlyingItem(state: f),
          ],
        ),
      ),
    );
  }
}

// =========================================================================
// Tray column — shuffled items on the left.
// =========================================================================
class _TrayColumn extends StatelessWidget {
  const _TrayColumn({
    required this.items,
    required this.trayKeys,
    required this.placedIds,
    required this.flyingItemId,
    required this.wobbleId,
    required this.onTap,
  });

  final List<ItemPoolEntry> items;
  final Map<String, GlobalKey> trayKeys;
  final Set<String> placedIds;
  final String? flyingItemId;
  final String? wobbleId;
  final ValueChanged<ItemPoolEntry> onTap;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final item in items) ...[
          Expanded(
            child: KeyedSubtree(
              key: trayKeys.putIfAbsent(item.id, GlobalKey.new),
              child: _TrayCard(
                item: item,
                placed: placedIds.contains(item.id),
                wobbling: wobbleId == item.id,
                hidden: flyingItemId == item.id,
                onTap: () => onTap(item),
              ),
            ),
          ),
          const SizedBox(height: 6),
        ],
      ],
    );
  }
}

class _TrayCard extends StatefulWidget {
  const _TrayCard({
    required this.item,
    required this.placed,
    required this.wobbling,
    required this.hidden,
    required this.onTap,
  });

  final ItemPoolEntry item;
  final bool placed;
  final bool wobbling;
  final bool hidden;
  final VoidCallback onTap;

  @override
  State<_TrayCard> createState() => _TrayCardState();
}

class _TrayCardState extends State<_TrayCard>
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
  void didUpdateWidget(covariant _TrayCard old) {
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
    if (widget.placed) {
      return const SizedBox.shrink();
    }
    return Opacity(
      opacity: widget.hidden ? 0 : 1,
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedBuilder(
          animation: _wobble,
          builder: (context, child) {
            final dx = sin(_wobble.value * pi * 4) * 6;
            return Transform.translate(offset: Offset(dx, 0), child: child);
          },
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.primary, width: 2),
            ),
            alignment: Alignment.center,
            padding: const EdgeInsets.all(8),
            child: AutoSizeText(
              widget.item.labelTr,
              textAlign: TextAlign.center,
              maxLines: 2,
              minFontSize: 12,
              wrapWords: false,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
        ),
      ),
    );
  }
}

// =========================================================================
// Order column — numbered slots on the right.
// =========================================================================
class _OrderColumn extends StatelessWidget {
  const _OrderColumn({
    required this.ordered,
    required this.slotKeys,
    required this.placedIds,
  });

  final List<ItemPoolEntry> ordered;
  final Map<int, GlobalKey> slotKeys;
  final Set<String> placedIds;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (int i = 0; i < ordered.length; i++) ...[
          Expanded(
            child: KeyedSubtree(
              key: slotKeys.putIfAbsent(i, GlobalKey.new),
              child: _OrderSlot(
                index: i + 1,
                item: ordered[i],
                placed: placedIds.contains(ordered[i].id),
              ),
            ),
          ),
          const SizedBox(height: 6),
        ],
      ],
    );
  }
}

class _OrderSlot extends StatelessWidget {
  const _OrderSlot({
    required this.index,
    required this.item,
    required this.placed,
  });

  final int index;
  final ItemPoolEntry item;
  final bool placed;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 250),
      decoration: BoxDecoration(
        color: placed
            ? AppColors.acceptGlow.withOpacity(0.3)
            : Colors.white.withOpacity(0.6),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: placed ? AppColors.acceptGlow : AppColors.slotOutline,
          width: 2,
        ),
      ),
      padding: const EdgeInsets.all(8),
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: AppColors.primary,
              shape: BoxShape.circle,
            ),
            child: Text(
              '$index',
              style: const TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: AutoSizeText(
              placed ? item.labelTr : '...',
              maxLines: 2,
              minFontSize: 12,
              wrapWords: false,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: placed ? AppColors.primary : AppColors.textMuted,
                    fontWeight:
                        placed ? FontWeight.w600 : FontWeight.w400,
                  ),
            ),
          ),
        ],
      ),
    );
  }
}

// =========================================================================
// Flying item overlay — animates from tray position to slot position.
// =========================================================================
class _FlyState {
  _FlyState({
    required this.key,
    required this.entry,
    required this.start,
    required this.end,
    required this.size,
  });
  final Key key;
  final ItemPoolEntry entry;
  final Offset start;
  final Offset end;
  final Size size;
}

class _FlyingItem extends StatefulWidget {
  const _FlyingItem({required this.state}) : super(key: const ValueKey('fly'));
  final _FlyState state;

  @override
  State<_FlyingItem> createState() => _FlyingItemState();
}

class _FlyingItemState extends State<_FlyingItem>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _t;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    )..forward();
    _t = CurvedAnimation(parent: _ctrl, curve: Curves.easeOutCubic);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _t,
      builder: (context, _) {
        final s = widget.state;
        final x = s.start.dx + (s.end.dx - s.start.dx) * _t.value;
        final y = s.start.dy + (s.end.dy - s.start.dy) * _t.value;
        return Positioned(
          left: x,
          top: y,
          width: s.size.width,
          height: s.size.height,
          child: IgnorePointer(
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.primary, width: 2),
                boxShadow: [
                  BoxShadow(
                    color: AppColors.acceptGlow.withOpacity(0.5),
                    blurRadius: 16,
                  ),
                ],
              ),
              alignment: Alignment.center,
              padding: const EdgeInsets.all(8),
              child: AutoSizeText(
                s.entry.labelTr,
                maxLines: 2,
                minFontSize: 12,
                wrapWords: false,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          ),
        );
      },
    );
  }
}
