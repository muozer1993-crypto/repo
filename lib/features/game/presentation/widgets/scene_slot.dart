import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../domain/scene.dart';

/// Visual-only slot. Not tappable — per clinical revision #1 we use a
/// tap-to-select mechanic where patients tap the tray item and the
/// item animates to this slot.
///
/// Positioned absolutely by the parent [SceneBoard] using the slot's
/// [SceneSlot.relativeRect] scaled to the board's actual size.
class SceneSlotWidget extends StatelessWidget {
  const SceneSlotWidget({
    required this.slot,
    required this.filled,
    required this.filledAssetPath,
    this.glowing = false,
    super.key,
  });

  final SceneSlot slot;
  final bool filled;

  /// Image asset to render once the slot is [filled]. Null until an
  /// item has been placed.
  final String? filledAssetPath;

  /// Whether the slot currently carries the accept-glow from a fresh
  /// correct placement. The parent clears this shortly after the
  /// placement animation finishes.
  final bool glowing;

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 350),
      curve: Curves.easeOutCubic,
      decoration: BoxDecoration(
        color: filled
            ? Colors.transparent
            : Colors.white.withValues(alpha: 0.20),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: glowing
              ? AppColors.acceptGlow
              : AppColors.slotOutline.withValues(alpha: filled ? 0.4 : 0.7),
          width: glowing ? 4 : 2,
        ),
        boxShadow: glowing
            ? [
                const BoxShadow(
                  color: AppColors.acceptGlow,
                  blurRadius: 24,
                  spreadRadius: 2,
                ),
              ]
            : null,
      ),
      padding: const EdgeInsets.all(12),
      child: Center(
        child: filled && filledAssetPath != null
            ? Image.asset(
                filledAssetPath!,
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) => const SizedBox.shrink(),
              )
            : Text(
                slot.labelTr,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  color: AppColors.textMuted,
                  fontStyle: FontStyle.italic,
                ),
              ),
      ),
    );
  }
}
