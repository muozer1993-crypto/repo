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

/// v2 bonus — "Eşini Bul" / pair_match.
///
/// Shows each item twice on a small grid; the patient taps item A,
/// then taps item B. If both taps landed on the same itemId the pair
/// pulses green and stays revealed. If not, both flip back after a
/// short pause — still no error tracking, still no red.
///
/// Completes when every pair has been revealed. Exit anytime.
class PairMatchWidget extends ConsumerStatefulWidget {
  const PairMatchWidget({
    required this.bonusScene,
    required this.onFinished,
    super.key,
  });

  final BonusScene bonusScene;
  final BonusPlayResultCallback onFinished;

  @override
  ConsumerState<PairMatchWidget> createState() => _PairMatchWidgetState();
}

class _PairMatchWidgetState extends ConsumerState<PairMatchWidget> {
  late final List<_Card> _cards;
  _Card? _firstFlipped;
  int _tapCount = 0;
  int _pairsFound = 0;
  bool _emitted = false;

  @override
  void initState() {
    super.initState();
    final pool = widget.bonusScene.itemPool.take(4).toList();
    final rng = Random(widget.bonusScene.id.hashCode);
    _cards = [
      for (final item in pool) _Card(item: item, slot: 'a_${item.id}'),
      for (final item in pool) _Card(item: item, slot: 'b_${item.id}'),
    ]..shuffle(rng);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            widget.bonusScene.instructionAudioPath,
          );
    });
  }

  void _onTap(_Card card) {
    if (card.matched || card.flipped) return;
    setState(() {
      card.flipped = true;
      _tapCount += 1;
    });
    ref.read(hapticsServiceProvider).selection();

    if (_firstFlipped == null) {
      _firstFlipped = card;
      return;
    }

    final first = _firstFlipped!;
    final second = card;
    _firstFlipped = null;

    if (first.item.id == second.item.id) {
      setState(() {
        first.matched = true;
        second.matched = true;
        _pairsFound += 1;
      });
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(audioServiceProvider).playItemLabel(second.item.audioLabelPath);

      if (_pairsFound >= widget.bonusScene.itemPool.take(4).length &&
          !_emitted) {
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
    } else {
      // Mismatch — flip both back after a pause.
      Future.delayed(const Duration(milliseconds: 900), () {
        if (!mounted) return;
        setState(() {
          first.flipped = false;
          second.flipped = false;
        });
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
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
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
                ],
              ),
            ),
            Expanded(
              child: Center(
                child: GridView.count(
                  shrinkWrap: true,
                  padding: const EdgeInsets.all(32),
                  crossAxisCount: 4,
                  mainAxisSpacing: 16,
                  crossAxisSpacing: 16,
                  children: [
                    for (final card in _cards)
                      _CardTile(card: card, onTap: () => _onTap(card)),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Card {
  _Card({required this.item, required this.slot});
  final ItemPoolEntry item;
  final String slot;
  bool flipped = false;
  bool matched = false;
}

class _CardTile extends StatelessWidget {
  const _CardTile({required this.card, required this.onTap});
  final _Card card;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final showFace = card.flipped || card.matched;
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        decoration: BoxDecoration(
          color: card.matched
              ? AppColors.acceptGlow.withOpacity(0.5)
              : showFace
                  ? Colors.white
                  : AppColors.primary,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.primary, width: 2),
        ),
        alignment: Alignment.center,
        padding: const EdgeInsets.all(8),
        child: showFace
            ? AutoSizeText(
                card.item.labelTr,
                textAlign: TextAlign.center,
                maxLines: 2,
                minFontSize: 12,
                style: Theme.of(context).textTheme.bodyMedium,
              )
            : const Icon(Icons.question_mark_rounded,
                size: 36, color: Colors.white),
      ),
    );
  }
}
