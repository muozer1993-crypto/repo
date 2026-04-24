import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/audio/audio_service.dart';
import '../../../../../core/haptics/haptics_service.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../../../../core/time/clock_provider.dart';
import '../../../domain/scene.dart';
import 'bonus_common.dart';

/// v2 bonus — "Sakin Bir An" / free_explore.
///
/// Grid of itemPool entries; tap anything to hear its label + soft
/// glow. No completion criteria, no scoring — the patient exits when
/// they feel done. This is the only bonus that ships with the
/// night-variant flag set on many scenes (see bonus_night_explore.json).
class FreeExploreWidget extends ConsumerStatefulWidget {
  const FreeExploreWidget({
    required this.bonusScene,
    required this.onFinished,
    super.key,
  });

  final BonusScene bonusScene;
  final BonusPlayResultCallback onFinished;

  @override
  ConsumerState<FreeExploreWidget> createState() =>
      _FreeExploreWidgetState();
}

class _FreeExploreWidgetState extends ConsumerState<FreeExploreWidget> {
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
      _tapCount += 1;
    });
    ref.read(audioServiceProvider).playItemLabel(entry.audioLabelPath);
    ref.read(hapticsServiceProvider).light();
    Future.delayed(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      setState(() {
        if (_glowId == entry.id) _glowId = null;
      });
    });
  }

  void _onExit() {
    if (_emitted) return;
    _emitted = true;
    widget.onFinished(BonusPlayResult(
      bonusSceneId: widget.bonusScene.id,
      bonusType: widget.bonusScene.bonusType,
      tapCount: _tapCount,
      finishedAt: _tapCount > 0 ? ref.read(clockProvider)() : null,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final palette = widget.bonusScene.nightVariant
        ? const Color(0xFF0E1C3D) // deep indigo for night mode
        : AppColors.background;
    final textColor = widget.bonusScene.nightVariant
        ? Colors.white
        : AppColors.textPrimary;

    return Scaffold(
      backgroundColor: palette,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  IconButton(
                    iconSize: 48,
                    color: textColor,
                    onPressed: _onExit,
                    icon: const Icon(Icons.close_rounded),
                  ),
                  Expanded(
                    child: AutoSizeText(
                      widget.bonusScene.instructionTr,
                      maxLines: 2,
                      minFontSize: 16,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            color: textColor,
                          ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: Center(
                child: Wrap(
                  spacing: 24,
                  runSpacing: 24,
                  alignment: WrapAlignment.center,
                  children: [
                    for (final entry in widget.bonusScene.itemPool)
                      _ExploreTile(
                        entry: entry,
                        glowing: _glowId == entry.id,
                        dark: widget.bonusScene.nightVariant,
                        onTap: () => _onTap(entry),
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

class _ExploreTile extends StatelessWidget {
  const _ExploreTile({
    required this.entry,
    required this.glowing,
    required this.dark,
    required this.onTap,
  });

  final ItemPoolEntry entry;
  final bool glowing;
  final bool dark;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        width: 140,
        height: 140,
        decoration: BoxDecoration(
          color: dark
              ? Colors.white.withOpacity(glowing ? 0.3 : 0.1)
              : (glowing ? AppColors.acceptGlow.withOpacity(0.5) : Colors.white),
          shape: BoxShape.circle,
          border: Border.all(
            color: dark ? Colors.white54 : AppColors.primary,
            width: 2,
          ),
          boxShadow: glowing
              ? [
                  BoxShadow(
                    color: (dark ? Colors.white : AppColors.acceptGlow)
                        .withOpacity(0.6),
                    blurRadius: 24,
                  ),
                ]
              : null,
        ),
        alignment: Alignment.center,
        padding: const EdgeInsets.all(12),
        child: AutoSizeText(
          entry.labelTr,
          textAlign: TextAlign.center,
          maxLines: 2,
          minFontSize: 14,
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: dark ? Colors.white : AppColors.textPrimary,
              ),
        ),
      ),
    );
  }
}
