import 'package:auto_size_text/auto_size_text.dart';
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
    // v2 — when filled, render the dolu_ image. When empty AND the
    // slot has a bos_ asset, render that as the in-place silhouette.
    // Otherwise fall back to the v1 dashed-outline + label.
    final hasBg = !filled && slot.emptyAssetPath != null;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 350),
      curve: Curves.easeOutCubic,
      decoration: BoxDecoration(
        color: filled
            ? AppColors.acceptGlow.withValues(alpha: 0.15)
            : (hasBg ? Colors.transparent : Colors.white.withValues(alpha: 0.65)),
        borderRadius: BorderRadius.circular(16),
        border: hasBg
            ? null
            : Border.all(
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
      padding: hasBg ? EdgeInsets.zero : const EdgeInsets.all(6),
      clipBehavior: Clip.antiAlias,
      child: Center(
        child: filled
            ? _FilledContent(
                assetPath: filledAssetPath,
                label: filledLabel,
              )
            : (slot.emptyAssetPath != null
                ? Image.asset(
                    slot.emptyAssetPath!,
                    fit: BoxFit.contain,
                    errorBuilder: (_, __, ___) =>
                        _EmptySlotLabel(text: slot.labelTr),
                  )
                : _EmptySlotLabel(text: slot.labelTr)),
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
        // Wrap first ("peynir" / "tabağı"), then shrink only if still
        // too tall; this keeps the target label readable at 15sp for
        // elderly users instead of collapsing to a tiny single line.
        Flexible(
          child: AutoSizeText(
            text,
            maxLines: 2,
            minFontSize: 12,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 15,
              color: AppColors.textMuted,
              fontStyle: FontStyle.italic,
              height: 1.2,
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
          Flexible(
            child: AutoSizeText(
              label!,
              maxLines: 2,
              minFontSize: 12,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 15,
                color: AppColors.textPrimary,
                fontWeight: FontWeight.w600,
                height: 1.2,
              ),
            ),
          ),
        ],
      ],
    );
  }
}
