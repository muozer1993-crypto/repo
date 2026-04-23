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
    required this.filledLabel,
    this.glowing = false,
    super.key,
  });

  final SceneSlot slot;
  final bool filled;

  /// Image asset to render once the slot is [filled]. Null until an
  /// item has been placed.
  final String? filledAssetPath;

  /// Item's Turkish label for the text fallback rendered when the
  /// image asset is missing (dev / early-preview builds).
  final String? filledLabel;

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
            ? AppColors.acceptGlow.withValues(alpha: 0.15)
            : Colors.white.withValues(alpha: 0.65),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: glowing
              ? AppColors.acceptGlow
              : (filled
                  ? AppColors.acceptGlow
                  : AppColors.slotOutline.withValues(alpha: 0.7)),
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
      padding: const EdgeInsets.all(6),
      child: Center(
        child: filled
            ? _FilledContent(
                assetPath: filledAssetPath,
                label: filledLabel,
              )
            : _EmptySlotLabel(text: slot.labelTr),
      ),
    );
  }
}

/// Empty-slot hint. FittedBox prevents the label from overflowing into
/// neighboring slots when the container is narrow (e.g. 65dp wide on
/// phone portrait).
class _EmptySlotLabel extends StatelessWidget {
  const _EmptySlotLabel({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const Icon(
          Icons.add_circle_outline_rounded,
          size: 22,
          color: AppColors.slotOutline,
        ),
        const SizedBox(height: 4),
        // Words like "çay bardağı" must not break mid-word on a
        // ~72dp-wide phone tile; scale-down + maxLines:1 keeps the
        // whole label visible, shrinking the font before ellipsing.
        FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 14,
              color: AppColors.textMuted,
              fontStyle: FontStyle.italic,
            ),
          ),
        ),
      ],
    );
  }
}

/// Filled-slot content. Prefers the image; falls back to a checkmark
/// + item label when the asset is missing so the patient still gets
/// a clear "yerleştirildi" signal.
class _FilledContent extends StatelessWidget {
  const _FilledContent({required this.assetPath, required this.label});

  final String? assetPath;
  final String? label;

  @override
  Widget build(BuildContext context) {
    if (assetPath != null) {
      return Image.asset(
        assetPath!,
        fit: BoxFit.contain,
        errorBuilder: (_, __, ___) => _TextualFallback(label: label),
      );
    }
    return _TextualFallback(label: label);
  }
}

class _TextualFallback extends StatelessWidget {
  const _TextualFallback({required this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(
          Icons.check_circle_rounded,
          size: 28,
          color: AppColors.acceptGlow,
        ),
        if (label != null) ...[
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              label!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                color: AppColors.textPrimary,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ],
    );
  }
}
