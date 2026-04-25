import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../core/theme/motion.dart';
import '../../../../core/time/time_window.dart';
import '../../../../l10n/strings_tr.dart';
import '../../domain/scene.dart';

/// Clinical revision #4 — shown between the home screen and the scene
/// board. Asks the patient "what time of day is it?".
///
/// Visual/text support scales with [difficultyLevel]:
///   0–1: analog + digital clock + scene icon.
///   2:   analog + digital clock, no scene icon.
///   3:   analog clock only, prompt retained.
///   4:   analog clock only, no prompt text.
///
/// Errorless: wrong taps wobble the chosen button — no ses/color penalty.
/// On first correct tap, [onAnswered] fires with elapsed ms so the
/// controller can record it on SessionLog.
class TimeOrientationCard extends ConsumerStatefulWidget {
  const TimeOrientationCard({
    required this.now,
    required this.expected,
    required this.difficultyLevel,
    required this.scene,
    required this.variant,
    required this.onAnswered,
    super.key,
  });

  final DateTime now;
  final TimeWindow expected;
  final int difficultyLevel;

  /// v2 — full scene + the variant the patient is about to play, so
  /// the orientation card can render a "dolu masa" preview (bos_
  /// background + each dolu_ item placed at its slot rect) instead of
  /// just the empty background.
  final Scene scene;
  final DifficultyVariant variant;

  final void Function({required bool correct, required int responseMs})
      onAnswered;

  @override
  ConsumerState<TimeOrientationCard> createState() =>
      _TimeOrientationCardState();
}

class _TimeOrientationCardState
    extends ConsumerState<TimeOrientationCard> {
  late final DateTime _start;
  final Map<TimeWindow, GlobalKey<_OrientationButtonState>> _keys = {
    for (final w in TimeWindow.values) w: GlobalKey<_OrientationButtonState>(),
  };
  bool _firstCorrect = false;

  @override
  void initState() {
    super.initState();
    _start = DateTime.now();
  }

  void _onTap(TimeWindow choice) {
    if (choice == widget.expected) {
      if (_firstCorrect) return;
      _firstCorrect = true;
      final ms = DateTime.now().difference(_start).inMilliseconds;
      widget.onAnswered(correct: true, responseMs: ms);
    } else {
      _keys[choice]?.currentState?.wobble();
    }
  }

  @override
  Widget build(BuildContext context) {
    final showDigital = widget.difficultyLevel <= 2;
    final showPrompt = widget.difficultyLevel <= 3;
    final showSceneIcon = widget.difficultyLevel <= 1;
    final t = Theme.of(context).textTheme;

    return Material(
      color: AppColors.background,
      child: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            // Scale the analog clock to fit narrow screens (phone
            // landscape gives only ~412dp height). Cap at 220 for
            // tablets so the clock does not look bloated.
            final isLandscape =
                constraints.maxWidth > constraints.maxHeight * 1.3;

            // In landscape the clock goes on the left and the
            // orientation buttons stack on the right so both fit
            // without scrolling. In portrait we keep the original
            // top-down layout.
            final clockSize = (isLandscape
                    ? constraints.maxHeight * 0.55
                    : constraints.maxHeight * 0.32)
                .clamp(120.0, 220.0);

            final promptText = showPrompt
                ? (showDigital
                    ? 'Saat ${_formatHour(widget.now)}. '
                        '${StringsTr.orientationQuestion}'
                    : StringsTr.orientationQuestion)
                : null;

            if (isLandscape) {
              // Both columns wrap in SingleChildScrollView so sub-pixel
              // height mismatches (the intermittent "overflowed by
              // 1.3 pixels" warning) degrade to a silent scroll
              // instead of the yellow/black overflow stripe.
              return Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(
                      child: SingleChildScrollView(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            if (showSceneIcon)
                              SizedBox(
                                height: 120,
                                child: _FilledScenePreview(
                                  scene: widget.scene,
                                  variant: widget.variant,
                                ),
                              ),
                            _Clock(
                              now: widget.now,
                              showDigital: showDigital,
                              size: clockSize,
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: SingleChildScrollView(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            if (promptText != null) ...[
                              Text(
                                promptText,
                                style: t.titleLarge,
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 12),
                            ],
                            _OrientationButtonColumn(
                              options: _options,
                              keys: _keys,
                              onTap: _onTap,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              );
            }

            return SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: constraints.maxHeight - 48,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (showSceneIcon) ...[
                      SizedBox(
                        height: 180,
                        child: _FilledScenePreview(
                          scene: widget.scene,
                          variant: widget.variant,
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    _Clock(
                      now: widget.now,
                      showDigital: showDigital,
                      size: clockSize,
                    ),
                    const SizedBox(height: 16),
                    if (promptText != null)
                      Text(
                        promptText,
                        style: t.titleLarge,
                        textAlign: TextAlign.center,
                      ),
                    const SizedBox(height: 24),
                    Wrap(
                      spacing: 16,
                      runSpacing: 16,
                      alignment: WrapAlignment.center,
                      children: _options
                          .map(
                            (opt) => _OrientationButton(
                              key: _keys[opt.$1],
                              label: opt.$2,
                              onTap: () => _onTap(opt.$1),
                            ),
                          )
                          .toList(growable: false),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  static const _options = <(TimeWindow, String)>[
    (TimeWindow.sabah, 'Sabah'),
    (TimeWindow.oglen, 'Öğle'),
    (TimeWindow.ikindi, 'İkindi'),
    (TimeWindow.aksam, 'Akşam'),
  ];

  String _formatHour(DateTime now) {
    final h = now.hour.toString().padLeft(2, '0');
    final m = now.minute.toString().padLeft(2, '0');
    return '$h:$m';
  }
}

class _Clock extends StatelessWidget {
  const _Clock({
    required this.now,
    required this.showDigital,
    this.size = 220,
  });

  final DateTime now;
  final bool showDigital;
  final double size;

  @override
  Widget build(BuildContext context) {
    final digitalFontSize = (size * 0.22).clamp(28.0, 48.0);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: size,
          height: size,
          child: CustomPaint(painter: _AnalogClockPainter(now: now)),
        ),
        if (showDigital) ...[
          const SizedBox(height: 8),
          Text(
            '${now.hour.toString().padLeft(2, '0')}:'
            '${now.minute.toString().padLeft(2, '0')}',
            style: TextStyle(
              fontSize: digitalFontSize,
              fontWeight: FontWeight.w600,
              color: AppColors.textPrimary,
            ),
          ),
        ],
      ],
    );
  }
}

class _AnalogClockPainter extends CustomPainter {
  _AnalogClockPainter({required this.now});

  final DateTime now;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.shortestSide / 2 - 4;

    final face = Paint()
      ..style = PaintingStyle.fill
      ..color = Colors.white;
    final ring = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 6
      ..color = AppColors.primary;
    canvas.drawCircle(center, radius, face);
    canvas.drawCircle(center, radius, ring);

    final tick = Paint()
      ..color = AppColors.primary
      ..strokeWidth = 3;
    for (int i = 0; i < 12; i++) {
      final angle = i * 30.0 * math.pi / 180.0;
      final inner = center +
          Offset(
            (radius - 12) * math.sin(angle),
            -(radius - 12) * math.cos(angle),
          );
      final outer = center +
          Offset(
            radius * math.sin(angle),
            -radius * math.cos(angle),
          );
      canvas.drawLine(inner, outer, tick);
    }

    final hourAngle =
        ((now.hour % 12) + now.minute / 60.0) * 30.0 * math.pi / 180;
    final minuteAngle = now.minute * 6.0 * math.pi / 180;

    final hourHand = Paint()
      ..color = AppColors.textPrimary
      ..strokeWidth = 8
      ..strokeCap = StrokeCap.round;
    final minuteHand = Paint()
      ..color = AppColors.textPrimary
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round;

    canvas.drawLine(
      center,
      center +
          Offset(
            radius * 0.55 * math.sin(hourAngle),
            -radius * 0.55 * math.cos(hourAngle),
          ),
      hourHand,
    );
    canvas.drawLine(
      center,
      center +
          Offset(
            radius * 0.80 * math.sin(minuteAngle),
            -radius * 0.80 * math.cos(minuteAngle),
          ),
      minuteHand,
    );

    canvas.drawCircle(center, 6, hourHand);
  }

  @override
  bool shouldRepaint(covariant _AnalogClockPainter old) => old.now != now;
}

/// Landscape-only stacked variant. Same buttons as the Wrap version
/// but arranged vertically so both the clock and the 4 options fit
/// side-by-side without scrolling on phone landscape.
class _OrientationButtonColumn extends StatelessWidget {
  const _OrientationButtonColumn({
    required this.options,
    required this.keys,
    required this.onTap,
  });

  final List<(TimeWindow, String)> options;
  final Map<TimeWindow, GlobalKey<_OrientationButtonState>> keys;
  final void Function(TimeWindow) onTap;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final opt in options) ...[
          _OrientationButton(
            key: keys[opt.$1],
            label: opt.$2,
            onTap: () => onTap(opt.$1),
          ),
          if (opt != options.last) const SizedBox(height: 10),
        ],
      ],
    );
  }
}

class _OrientationButton extends StatefulWidget {
  const _OrientationButton({
    required this.label,
    required this.onTap,
    super.key,
  });

  final String label;
  final VoidCallback onTap;

  @override
  State<_OrientationButton> createState() => _OrientationButtonState();
}

class _OrientationButtonState extends State<_OrientationButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: MotionDurations.wobble);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> wobble() async {
    _c.value = 0;
    await _c.forward();
    _c.value = 0;
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) {
        final dx = _c.value == 0
            ? 0.0
            : (_c.value < 0.5 ? _c.value : 1 - _c.value) * 10;
        return Transform.translate(
          offset: Offset(dx, 0),
          child: ElevatedButton(
            onPressed: widget.onTap,
            style: ElevatedButton.styleFrom(
              minimumSize: const Size(140, 56),
              padding: const EdgeInsets.symmetric(
                horizontal: 24,
                vertical: 12,
              ),
            ),
            child: Text(widget.label, style: const TextStyle(fontSize: 22)),
          ),
        );
      },
    );
  }
}


/// v2 — composite preview for the orientation card: shows the
/// `bos_<area>.png` table with each `dolu_<itemId>.png` overlaid at
/// the slot rect the patient is about to fill. Gives the patient a
/// "destination" image so they know what the goal looks like before
/// the game starts. Distractors are intentionally omitted — only
/// targets show, all in their final positions.
class _FilledScenePreview extends StatelessWidget {
  const _FilledScenePreview({required this.scene, required this.variant});

  final Scene scene;
  final DifficultyVariant variant;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: LayoutBuilder(
        builder: (context, c) {
          return Stack(
            fit: StackFit.expand,
            children: [
              Image.asset(
                scene.backgroundAsset,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) =>
                    const ColoredBox(color: Color(0xFFE9D9B7)),
              ),
              for (final slot in scene.slots)
                _previewItemFor(slot, c.maxWidth, c.maxHeight),
            ],
          );
        },
      ),
    );
  }

  Widget _previewItemFor(SceneSlot slot, double w, double h) {
    final item = variant.items.firstWhere(
      (i) => !i.distractor && i.acceptedSlotId == slot.id,
      orElse: () => const SceneItem(
        id: ,
        assetPath: ,
        audioLabelPath: ,
        labelTr: ,
      ),
    );
    if (item.id.isEmpty) return const SizedBox.shrink();
    return Positioned(
      left: slot.relativeRect.left * w,
      top: slot.relativeRect.top * h,
      width: slot.relativeRect.width * w,
      height: slot.relativeRect.height * h,
      child: Image.asset(
        item.assetPath,
        fit: BoxFit.contain,
        errorBuilder: (_, __, ___) => const SizedBox.shrink(),
      ),
    );
  }
}
