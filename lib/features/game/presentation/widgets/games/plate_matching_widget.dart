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

/// v2 Game-2 type 1 — "Tabağa Yerleştir".
///
/// One "plate" (central silhouette) matches exactly one correct item
/// from the scene's itemPool. The tray shows that item plus 2–3
/// distractors. Patient taps items; correct tap flies to plate + soft
/// glow + audio; wrong tap wobbles silently (errorless).
///
/// Completes after the first correct placement. That's intentionally
/// short — Game-2 is a cognitive warm-down after Game-1, not another
/// full session.
class PlateMatchingWidget extends ConsumerStatefulWidget {
  const PlateMatchingWidget({super.key});

  @override
  ConsumerState<PlateMatchingWidget> createState() =>
      _PlateMatchingWidgetState();
}

class _PlateMatchingWidgetState extends ConsumerState<PlateMatchingWidget> {
  late final DateTime _sessionStart;
  DateTime? _lastTapAt;
  late final List<ItemPoolEntry> _trayItems;
  late final ItemPoolEntry _correctItem;

  int _errorCount = 0;
  bool _completed = false;
  String? _wobbleItemId;
  String? _glowItemId;
  final List<PlacementEvent> _placements = [];

  @override
  void initState() {
    super.initState();
    final clock = ref.read(clockProvider);
    _sessionStart = clock();
    final session = ref.read(gameSessionControllerProvider);
    final pool = session.scene.itemPool.where((e) => e.isTarget).toList();
    final distractors =
        session.scene.itemPool.where((e) => !e.isTarget).toList();

    // Pick one target + 2 distractors (+ 1 more target as near distractor)
    final rng = Random(session.sessionId.hashCode);
    pool.shuffle(rng);
    distractors.shuffle(rng);

    _correctItem = pool.first;
    _trayItems = [
      _correctItem,
      if (pool.length > 1) pool[1],
      if (distractors.isNotEmpty) distractors[0],
      if (distractors.length > 1) distractors[1],
    ]..shuffle(rng);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            session.scene.game2!.instructionAudioPath,
          );
    });
  }

  void _onTap(ItemPoolEntry entry) {
    if (_completed) return;
    final now = ref.read(clockProvider)();
    final correct = entry.id == _correctItem.id;

    final deps = _deps();
    _placements.add(
      buildGame2PlacementEvent(
        deps: deps,
        itemId: entry.id,
        targetSlotId: _correctItem.defaultSlotId ?? '',
        outcome: correct ? Game2Outcome.correct : Game2Outcome.wrong,
        tappedDistractor: !entry.isTarget,
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
      setState(() {
        _glowItemId = entry.id;
        _completed = true;
      });
      Future.delayed(const Duration(milliseconds: 700), _emitResult);
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
      Future.delayed(
        wobble + const Duration(milliseconds: 50),
        () {
          if (!mounted) return;
          setState(() => _wobbleItemId = null);
        },
      );
    }
  }

  void _emitResult() {
    if (!mounted) return;
    ref.read(gameSessionControllerProvider.notifier).onGame2Result(
          Game2Result(
            type: Game2Type.plateMatching,
            errorCount: _errorCount,
            completed: _completed,
            placements: List.of(_placements),
          ),
        );
  }

  Game2Deps _deps() {
    final session = ref.read(gameSessionControllerProvider);
    return Game2Deps(
      config: session.scene.game2!,
      scene: session.scene,
      variant: session.variant,
      clock: ref.read(clockProvider),
      profileId: '', // wired through session controller in Faz D
      sessionId: session.sessionId,
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
                StringsTr.game2PlateMatchingTitle,
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
              const SizedBox(height: 32),
              Expanded(
                flex: 3,
                child: _PlateSilhouette(
                  label: _correctItem.labelTr,
                  filled: _glowItemId == _correctItem.id,
                ),
              ),
              const SizedBox(height: 16),
              Expanded(
                flex: 2,
                child: _Tray(
                  items: _trayItems,
                  wobbleId: _wobbleItemId,
                  glowId: _glowItemId,
                  onTap: _onTap,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlateSilhouette extends StatelessWidget {
  const _PlateSilhouette({required this.label, required this.filled});
  final String label;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 240,
        height: 240,
        decoration: BoxDecoration(
          color: filled
              ? AppColors.acceptGlow.withOpacity(0.6)
              : AppColors.background,
          shape: BoxShape.circle,
          border: Border.all(color: AppColors.primary, width: 4),
        ),
        alignment: Alignment.center,
        child: filled
            ? const Icon(Icons.check_rounded,
                size: 96, color: AppColors.primary)
            : Padding(
                padding: const EdgeInsets.all(24),
                child: AutoSizeText(
                  label,
                  textAlign: TextAlign.center,
                  style: Theme.of(context)
                      .textTheme
                      .titleLarge
                      ?.copyWith(color: AppColors.textSecondary),
                  maxLines: 2,
                  minFontSize: 16,
                ),
              ),
      ),
    );
  }
}

class _Tray extends StatelessWidget {
  const _Tray({
    required this.items,
    required this.wobbleId,
    required this.glowId,
    required this.onTap,
  });

  final List<ItemPoolEntry> items;
  final String? wobbleId;
  final String? glowId;
  final ValueChanged<ItemPoolEntry> onTap;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Wrap(
        spacing: 24,
        runSpacing: 16,
        alignment: WrapAlignment.center,
        children: [
          for (final item in items)
            _TrayTile(
              item: item,
              wobbling: wobbleId == item.id,
              glowing: glowId == item.id,
              onTap: () => onTap(item),
            ),
        ],
      ),
    );
  }
}

class _TrayTile extends StatefulWidget {
  const _TrayTile({
    required this.item,
    required this.wobbling,
    required this.glowing,
    required this.onTap,
  });

  final ItemPoolEntry item;
  final bool wobbling;
  final bool glowing;
  final VoidCallback onTap;

  @override
  State<_TrayTile> createState() => _TrayTileState();
}

class _TrayTileState extends State<_TrayTile>
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
  void didUpdateWidget(covariant _TrayTile old) {
    super.didUpdateWidget(old);
    if (widget.wobbling && !old.wobbling) {
      _wobble.forward(from: 0);
    }
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
          final offset = sin(_wobble.value * pi * 4) * 6;
          return Transform.translate(
            offset: Offset(offset, 0),
            child: child,
          );
        },
        child: Container(
          width: 128,
          height: 128,
          decoration: BoxDecoration(
            color: widget.glowing
                ? AppColors.acceptGlow.withOpacity(0.4)
                : Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.primary, width: 2),
          ),
          alignment: Alignment.center,
          padding: const EdgeInsets.all(8),
          child: AutoSizeText(
            widget.item.labelTr,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.titleMedium,
            maxLines: 2,
            minFontSize: 14,
          ),
        ),
      ),
    );
  }
}
