import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/audio/audio_service.dart';
import '../../../../../core/haptics/haptics_service.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../../../../core/time/clock_provider.dart';
import '../../../domain/scene.dart';
import 'bonus_common.dart';

/// v2 bonus — "Müzikli Dokunmalar" / tap_sequence.
///
/// Shows N colour-coded tap pads (up to 4 — red, yellow, green, blue).
/// Each tap plays a gentle tone + soft glow. Completes when the
/// patient taps each pad at least once (order does not matter in
/// v2 — it's a relaxing rhythm toy, not Simon Says). The patient can
/// exit anytime with the close button.
class TapSequenceWidget extends ConsumerStatefulWidget {
  const TapSequenceWidget({
    required this.bonusScene,
    required this.onFinished,
    super.key,
  });

  final BonusScene bonusScene;
  final BonusPlayResultCallback onFinished;

  @override
  ConsumerState<TapSequenceWidget> createState() =>
      _TapSequenceWidgetState();
}

class _TapSequenceWidgetState extends ConsumerState<TapSequenceWidget> {
  static const List<Color> _padColors = [
    Color(0xFFE88A82), // coral
    Color(0xFFF0C96C), // amber
    Color(0xFFA8D5A2), // green
    Color(0xFF7FB8C9), // blue
  ];

  final Set<String> _tapped = {};
  int _tapCount = 0;
  String? _glowId;
  bool _emitted = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(audioServiceProvider).playInstruction(
            widget.bonusScene.instructionAudioPath,
          );
    });
  }

  void _onTap(ItemPoolEntry entry) {
    setState(() {
      _glowId = entry.id;
      _tapped.add(entry.id);
      _tapCount += 1;
    });
    ref.read(audioServiceProvider).playItemLabel(entry.audioLabelPath);
    ref.read(hapticsServiceProvider).light();

    Future.delayed(const Duration(milliseconds: 350), () {
      if (!mounted) return;
      setState(() => _glowId = null);
    });

    if (_tapped.length >= widget.bonusScene.itemPool.length && !_emitted) {
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
    final pads = widget.bonusScene.itemPool;
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
                  crossAxisCount: 2,
                  padding: const EdgeInsets.all(32),
                  mainAxisSpacing: 24,
                  crossAxisSpacing: 24,
                  children: [
                    for (int i = 0; i < pads.length && i < 4; i++)
                      _Pad(
                        entry: pads[i],
                        color: _padColors[i % _padColors.length],
                        glowing: _glowId == pads[i].id,
                        onTap: () => _onTap(pads[i]),
                      ),
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

class _Pad extends StatelessWidget {
  const _Pad({
    required this.entry,
    required this.color,
    required this.glowing,
    required this.onTap,
  });

  final ItemPoolEntry entry;
  final Color color;
  final bool glowing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        decoration: BoxDecoration(
          color: glowing ? color.withOpacity(0.9) : color.withOpacity(0.5),
          borderRadius: BorderRadius.circular(24),
          boxShadow: glowing
              ? [
                  BoxShadow(
                    color: color.withOpacity(0.5),
                    blurRadius: 24,
                  ),
                ]
              : null,
        ),
        alignment: Alignment.center,
        child: AutoSizeText(
          entry.labelTr,
          style: Theme.of(context).textTheme.displayLarge?.copyWith(
                color: Colors.white,
              ),
          maxLines: 1,
          minFontSize: 24,
        ),
      ),
    );
  }
}
