import 'package:auto_size_text/auto_size_text.dart';
import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../l10n/strings_tr.dart';
import '../../../../shared/widgets/big_button.dart';

/// v2 — surfaced on the home screen when:
///   1. The patient has already completed the current window's scene
///      at least once today (→ this is their 2nd+ entry), AND
///   2. The current scene has a bonusSceneId defined, AND
///   3. The bonus has not yet been played today for this window.
///
/// A second use is for the night window — [BonusOfferTile] is
/// permanently visible during dinlenme when a night-bonus scene is
/// registered for the day.
class BonusOfferTile extends StatelessWidget {
  const BonusOfferTile({
    required this.titleTr,
    required this.subtitleTr,
    required this.onAccept,
    required this.onDecline,
    this.compact = false,
    super.key,
  });

  final String titleTr;
  final String subtitleTr;
  final VoidCallback onAccept;
  final VoidCallback onDecline;

  /// When true, renders without the "Hayır, teşekkürler" button — used
  /// for the always-on night-bonus tile where declining just means
  /// not tapping.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppColors.acceptGlow.withOpacity(0.2),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.primary, width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AutoSizeText(
            titleTr,
            maxLines: 2,
            minFontSize: 20,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                  color: AppColors.primaryDark,
                  fontWeight: FontWeight.w600,
                ),
          ),
          const SizedBox(height: 8),
          AutoSizeText(
            subtitleTr,
            maxLines: 3,
            minFontSize: 14,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 20),
          compact
              ? BigButton(
                  label: StringsTr.bonusOfferAccept,
                  icon: Icons.favorite_rounded,
                  onPressed: onAccept,
                  expand: true,
                )
              : Row(
                  children: [
                    Expanded(
                      child: TextButton(
                        onPressed: onDecline,
                        style: TextButton.styleFrom(
                          minimumSize: const Size(0, 72),
                          textStyle:
                              Theme.of(context).textTheme.titleLarge,
                        ),
                        child: const Text(StringsTr.bonusOfferDecline),
                      ),
                    ),
                    const SizedBox(width: 16),
                    BigButton(
                      label: StringsTr.bonusOfferAccept,
                      icon: Icons.favorite_rounded,
                      onPressed: onAccept,
                    ),
                  ],
                ),
        ],
      ),
    );
  }
}
