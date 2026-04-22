import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../core/theme/motion.dart';
import '../../../../core/time/time_window.dart';
import '../../../../l10n/strings_tr.dart';

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
    required this.sceneIconAsset,
    required this.onAnswered,
    super.key,
  });

  final DateTime now;
  final TimeWindow expected;
  final int difficultyLevel;
  final String sceneIconAsset;
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
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            children: [
              if (showSceneIcon) ...[
                SizedBox(
                  height: 120,
                  child: Image.asset(
                    widget.sceneIconAsset,
                    errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                  ),
                ),
                const SizedBox(height: 24),
              ],
              _Clock(now: widget.now, showDigital: showDigital),
              const SizedBox(height: 24),
              if (showPrompt)
                Text(
                  showDigital
                      ? 'Saat ${_formatHour(widget.now)}. ${StringsTr.orientationQuestion}'
                      : StringsTr.orientationQuestion,
                  style: t.titleLarge,
                  textAlign: TextAlign.center,
                ),
              const Spacer(),
              Wrap(
                spacing: 20,
                runSpacing: 20,
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
              const Spacer(),
            ],
          ),
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
  const _Clock({required this.now, required this.showDigital});

  final DateTime now;
  final bool showDigital;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        SizedBox(
          width: 220,
          height: 220,
          child: CustomPaint(painter: _AnalogClockPainter(now: now)),
        ),
        if (showDigital) ...[
          const SizedBox(height: 12),
          Text(
            '${now.hour.toString().padLeft(2, '0')}:'
            '${now.minute.toString().padLeft(2, '0')}',
            style: const TextStyle(
              fontSize: 48,
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
              minimumSize: const Size(160, 72),
              padding:
                  const EdgeInsets.symmetric(horizontal: 32, vertical: 20),
            ),
            child: Text(widget.label, style: const TextStyle(fontSize: 24)),
          ),
        );
      },
    );
  }
}
