import 'package:flutter/material.dart';

/// Tablet-first, accessibility-focused theme for MCI patients.
///
/// Design principles baked in:
///   * No pure red anywhere — wrong placements never feel punitive.
///   * Min touch target 64dp (Material baseline is 48dp).
///   * Base text 24sp; headings 32–40sp; line-height 1.4.
///   * Warm cream background with high-contrast teal primary.
class AppColors {
  const AppColors._();

  /// Warm cream page background — easier on older eyes than pure white.
  static const Color background = Color(0xFFFFF8EC);

  /// Dark teal primary — passes WCAG AA against [background].
  static const Color primary = Color(0xFF2E6F6A);

  /// Deeper teal for pressed / focused states.
  static const Color primaryDark = Color(0xFF1F504C);

  /// Soft green used only for correct-placement glow. Never red for errors.
  static const Color acceptGlow = Color(0xFFA8D5A2);

  /// Neutral slot outline.
  static const Color slotOutline = Color(0xFFBFAE8E);

  /// Subtle pulse tint for the hint timer.
  static const Color hintPulse = Color(0xFFCFE5CB);

  /// Primary text — near-black, not pure black (softer on cream).
  static const Color textPrimary = Color(0xFF1F1A14);

  /// Secondary text for captions / chrome.
  static const Color textSecondary = Color(0xFF5B5346);

  /// Disabled / dinlenme state text.
  static const Color textMuted = Color(0xFF8B8275);
}

class AppTheme {
  const AppTheme._();

  /// Minimum touch target across the app. Material's 48dp is too small
  /// for elderly / tremor-prone users.
  static const double minTouchTarget = 64.0;

  /// Minimum slot hit area (slots are larger than items so misses are rare).
  static const double minSlotHitArea = 120.0;

  static ThemeData light() {
    const seedColor = AppColors.primary;
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorSchemeSeed: seedColor,
      scaffoldBackgroundColor: AppColors.background,
      visualDensity: VisualDensity.comfortable,
    );

    final textTheme = base.textTheme
        .apply(
          bodyColor: AppColors.textPrimary,
          displayColor: AppColors.textPrimary,
          fontSizeFactor: 1.0,
        )
        .copyWith(
          displayLarge: const TextStyle(
            fontSize: 48,
            fontWeight: FontWeight.w600,
            height: 1.2,
            color: AppColors.textPrimary,
          ),
          headlineLarge: const TextStyle(
            fontSize: 40,
            fontWeight: FontWeight.w600,
            height: 1.3,
            color: AppColors.textPrimary,
          ),
          headlineMedium: const TextStyle(
            fontSize: 32,
            fontWeight: FontWeight.w600,
            height: 1.3,
            color: AppColors.textPrimary,
          ),
          titleLarge: const TextStyle(
            fontSize: 28,
            fontWeight: FontWeight.w600,
            height: 1.35,
            color: AppColors.textPrimary,
          ),
          bodyLarge: const TextStyle(
            fontSize: 24,
            height: 1.4,
            color: AppColors.textPrimary,
          ),
          bodyMedium: const TextStyle(
            fontSize: 20,
            height: 1.4,
            color: AppColors.textPrimary,
          ),
          labelLarge: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            height: 1.2,
          ),
        );

    return base.copyWith(
      textTheme: textTheme,
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.background,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 28,
          fontWeight: FontWeight.w600,
          color: AppColors.textPrimary,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          minimumSize: const Size(minTouchTarget, minTouchTarget),
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 20),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
          ),
          textStyle: const TextStyle(
            fontSize: 24,
            fontWeight: FontWeight.w600,
            height: 1.2,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.primary,
          minimumSize: const Size(minTouchTarget, minTouchTarget),
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 20),
          side: const BorderSide(color: AppColors.primary, width: 2),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
          ),
          textStyle: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      iconTheme: const IconThemeData(
        color: AppColors.primary,
        size: 32,
      ),
    );
  }
}
