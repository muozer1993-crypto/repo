import 'dart:math';

import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/audio/audio_service.dart';
import '../../../../../core/haptics/haptics_service.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../../../../core/time/clock_provider.dart';
import '../../../domain/scene.dart';
import 'bonus_common.dart';

/// v2 bonus — "Bul Bakalım". Items are scattered randomly on the
/// background; the patient taps each to reveal it with a soft
/// audio/glow. No errors (taps on empty space do nothing), no timer.
/// Completes when all items are found, or can be exited at any time.
class FindItemWidget extends ConsumerStatefulWidget {
  const FindItemWidget({
    required this.bonusScene,
    required this.onFinished,
    super.key,
  });

  final BonusScene bonusScene;
  final BonusPlayResultCallback onFinished;

  @override
  ConsumerState<FindItemWidget> createState() => _FindItemWidgetState();
}

class _FindItemWidgetState extends ConsumerState<FindItemWidget> {
  late final List<_ItemPosition> _positions;
  final Set<String> _found = {};
  int _tapCount = 0;
  bool _emitted = false;

  @override
  void initState() {
    super.initState();
    final rng = Random(widget.bonusScene.id.hashCode);
    _positions = [
      for (final item in widget.bonusScene.itemPool.take(6))
        _ItemPosition(
          item: item,
          left: 0.1 + rng.nextDouble() * 0.7,
          top: 0.2 + rng.nextDouble() * 0.6,
        ),
    ];

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            widget.bonusScene.instructionAudioPath,
          );
    });
  }

  void _onTap(_ItemPosition pos) {
    if (_found.contains(pos.item.id)) return;
    setState(() {
      _found.add(pos.item.id);
      _tapCount += 1;
    });
    ref.read(audioServiceProvider).playItemLabel(pos.item.audioLabelPath);
    ref.read(hapticsServiceProvider).light();

    if (_found.length >= _positions.length && !_emitted) {
      _emitted = true;
      Future.delayed(const Duration(milliseconds: 800), () {
        if (!mounted) return;
        widget.onFinished(BonusPlayResult(
          bonusSceneId: widget.bonusScene.id,
          bonusType: widget.bonusScene.bonusType,
          tapCount: _tapCount,
          finishedAt: ref.read(clockProvider)(),
        ));
      });
    }
  }

  void _onExitEarly() {
    if (_emitted) return;
    _emitted = true;
    widget.onFinished(BonusPlayResult(
      bonusSceneId: widget.bonusScene.id,
      bonusType: widget.bonusScene.bonusType,
      tapCount: _tapCount,
      finishedAt: null,
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        child: Stack(
          children: [
            LayoutBuilder(
              builder: (context, constraints) {
                return Stack(
                  children: [
                    for (final pos in _positions)
                      Positioned(
                        left: pos.left * constraints.maxWidth - 48,
                        top: pos.top * constraints.maxHeight - 48,
                        child: GestureDetector(
                          onTap: () => _onTap(pos),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 300),
                            width: 96,
                            height: 96,
                            decoration: BoxDecoration(
                              color: _found.contains(pos.item.id)
                                  ? AppColors.acceptGlow.withOpacity(0.5)
                                  : Colors.white.withOpacity(0.6),
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: AppColors.primary,
                                width: 2,
                              ),
                            ),
                            alignment: Alignment.center,
                            padding: const EdgeInsets.all(8),
                            child: _found.contains(pos.item.id)
                                ? AutoSizeText(
                                    pos.item.labelTr,
                                    textAlign: TextAlign.center,
                                    maxLines: 2,
                                    minFontSize: 10,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  )
                                : const Icon(Icons.help_outline,
                                    color: AppColors.primary),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
            Positioned(
              top: 16,
              left: 16,
              right: 16,
              child: Row(
                children: [
                  IconButton(
                    iconSize: 48,
                    onPressed: _onExitEarly,
                    icon: const Icon(Icons.close_rounded),
                  ),
                  Expanded(
                    child: AutoSizeText(
                      widget.bonusScene.instructionTr,
                      maxLines: 2,
                      minFontSize: 16,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  _FoundCounter(
                    found: _found.length,
                    total: _positions.length,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ItemPosition {
  const _ItemPosition({
    required this.item,
    required this.left,
    required this.top,
  });
  final ItemPoolEntry item;
  final double left;
  final double top;
}

class _FoundCounter extends StatelessWidget {
  const _FoundCounter({required this.found, required this.total});
  final int found;
  final int total;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.acceptGlow.withOpacity(0.3),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        '$found / $total',
        style: Theme.of(context).textTheme.titleLarge,
      ),
    );
  }
}
