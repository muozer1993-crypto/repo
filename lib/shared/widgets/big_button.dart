import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';

/// v2 — visual variants for [BigButton]. The whole app uses these so
/// "buton gibi görünmesi gereken" yerlerde renkler aynı şekilde
/// dağılır:
///   * primary  → onay / ana eylem (teal)
///   * accept   → "evet, devam edelim" (yumuşak yeşil)
///   * warning  → "şimdilik yeterli", "daha sonra" (turuncu)
///   * danger   → "çıkış", "vazgeç" (kırmızı-tonlu — uyarı amaçlı; oyun
///               ekranları yine renksiz wobble feedback kullanır)
///   * neutral  → bilgilendirici / ikincil eylemler (gri)
enum BigButtonVariant { primary, accept, warning, danger, neutral }

/// Primary CTA used across the app.
///
/// Enforces the minimum 64dp touch target and large readable label.
/// Always renders as a real, filled button (Material `ElevatedButton`)
/// so on-screen affordance is unambiguous — no flat-text buttons in
/// the patient flow.
///
/// v2 additions:
///   * [variant] — pick a colour. Defaults to primary.
///   * Label text is auto-shrunk via [AutoSizeText] so long Turkish
///     copy ("şimdilik yeterli") never word-breaks (`wrapWords: false`).
class BigButton extends StatelessWidget {
  const BigButton({
    required this.label,
    required this.onPressed,
    this.icon,
    this.expand = false,
    this.variant = BigButtonVariant.primary,
    this.compact = false,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  /// If true, stretches to fill the parent's width.
  final bool expand;

  final BigButtonVariant variant;

  /// v2 — [compact] uses 56dp tall + smaller padding. Use it when the
  /// button row needs to fit in tight space (e.g. onboarding /
  /// transition screens on phones in landscape).
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final colors = _palette(variant);
    final minHeight = compact ? 56.0 : AppTheme.minTouchTarget;
    final hPad = compact ? 24.0 : 40.0;
    final vPad = compact ? 16.0 : 24.0;
    final iconSize = compact ? 24.0 : 32.0;
    final fontSize = compact ? 18.0 : 22.0;

    final button = ElevatedButton(
      onPressed: onPressed,
      style: ElevatedButton.styleFrom(
        backgroundColor: colors.background,
        foregroundColor: colors.foreground,
        disabledBackgroundColor: colors.background.withOpacity(0.4),
        disabledForegroundColor: colors.foreground.withOpacity(0.6),
        minimumSize: Size(
          expand ? double.infinity : minHeight,
          minHeight,
        ),
        padding: EdgeInsets.symmetric(horizontal: hPad, vertical: vPad),
        elevation: 2,
        shadowColor: colors.shadow,
        textStyle: TextStyle(
          fontSize: fontSize,
          fontWeight: FontWeight.w600,
        ),
      ),
      child: Row(
        mainAxisSize: expand ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon != null) ...[
            Icon(icon, size: iconSize),
            const SizedBox(width: 12),
          ],
          Flexible(
            child: AutoSizeText(
              label,
              // 2 lines + small minFontSize so Turkish copy like
              // "Şimdilik yeterli" never ellipsizes to "Şi…" — it
              // wraps to two lines with shrunk font instead.
              maxLines: 2,
              minFontSize: 10,
              wrapWords: false,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: fontSize,
                fontWeight: FontWeight.w600,
                height: 1.1,
              ),
            ),
          ),
        ],
      ),
    );

    return expand ? SizedBox(width: double.infinity, child: button) : button;
  }
}

class _BtnPalette {
  const _BtnPalette({
    required this.background,
    required this.foreground,
    required this.shadow,
  });
  final Color background;
  final Color foreground;
  final Color shadow;
}

_BtnPalette _palette(BigButtonVariant v) {
  switch (v) {
    case BigButtonVariant.primary:
      return const _BtnPalette(
        background: AppColors.primary,
        foreground: Colors.white,
        shadow: AppColors.primaryDark,
      );
    case BigButtonVariant.accept:
      return _BtnPalette(
        background: AppColors.acceptGlow,
        foreground: AppColors.primaryDark,
        shadow: AppColors.acceptGlow.withOpacity(0.6),
      );
    case BigButtonVariant.warning:
      return const _BtnPalette(
        background: Color(0xFFE8945A), // soft amber/orange
        foreground: Colors.white,
        shadow: Color(0xFFB36F38),
      );
    case BigButtonVariant.danger:
      return const _BtnPalette(
        background: Color(0xFFB66B66), // muted brick (no harsh red)
        foreground: Colors.white,
        shadow: Color(0xFF8A4A45),
      );
    case BigButtonVariant.neutral:
      return _BtnPalette(
        background: AppColors.slotOutline,
        foreground: AppColors.textPrimary,
        shadow: AppColors.slotOutline.withOpacity(0.6),
      );
  }
}
