import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/motion.dart';

/// Curves an item from its tray position to the accepted slot using a
/// quadratic Bezier whose control point is offset perpendicular to
/// the start→end vector — produces a "C harfi yay" arc that's
/// distinct per item (each items' direction is unique, so no two
/// items follow the same path).
///
/// The scene board creates one overlay per in-flight item and disposes
/// it when the animation finishes.
class FlyingItemOverlay extends ConsumerStatefulWidget {
  const FlyingItemOverlay({
    required this.assetPath,
    required this.start,
    required this.end,
    required this.size,
    required this.onFinished,
    super.key,
  });

  /// Top-left in global coordinates.
  final Offset start;

  /// Top-left in global coordinates.
  final Offset end;

  final Size size;
  final String assetPath;
  final VoidCallback onFinished;

  @override
  ConsumerState<FlyingItemOverlay> createState() =>
      _FlyingItemOverlayState();
}

class _FlyingItemOverlayState extends ConsumerState<FlyingItemOverlay>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    final reduced = ref.read(reducedMotionProvider);
    _c = AnimationController(
      vsync: this,
      duration: pickMotion(
        full: MotionDurations.itemFly,
        reduced: MotionDurations.itemFlyReduced,
        isReduced: reduced,
      ),
    )..forward().whenComplete(widget.onFinished);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = Curves.easeOutCubic.transform(_c.value);
        final pos = _bezier(widget.start, widget.end, t);
        return Positioned(
          left: pos.dx,
          top: pos.dy,
          width: widget.size.width,
          height: widget.size.height,
          child: IgnorePointer(
            child: Image.asset(
              widget.assetPath,
              fit: BoxFit.contain,
              errorBuilder: (_, __, ___) => const SizedBox.shrink(),
            ),
          ),
        );
      },
    );
  }

  /// Quadratic Bezier with the control point offset perpendicular to
  /// the direct line by 40% of the distance, biased so the arc bows
  /// upward (toward smaller Y / off-screen). Produces a curved arc
  /// instead of a straight rise.
  Offset _bezier(Offset a, Offset b, double t) {
    final dx = b.dx - a.dx;
    final dy = b.dy - a.dy;
    final dist = sqrt(dx * dx + dy * dy);
    if (dist < 1) return a;

    // Unit perpendicular (90° rotation of the direct line).
    var perpX = -dy / dist;
    var perpY = dx / dist;

    // Always bow upward (negative Y in screen coords). If the natural
    // perpendicular has a positive Y component it would arc downward,
    // so flip both axes to keep the arc consistently above the line.
    if (perpY > 0) {
      perpX = -perpX;
      perpY = -perpY;
    }

    final arcMagnitude = dist * 0.45;
    final cx = (a.dx + b.dx) / 2 + perpX * arcMagnitude;
    final cy = (a.dy + b.dy) / 2 + perpY * arcMagnitude;

    final x =
        (1 - t) * (1 - t) * a.dx + 2 * (1 - t) * t * cx + t * t * b.dx;
    final y =
        (1 - t) * (1 - t) * a.dy + 2 * (1 - t) * t * cy + t * t * b.dy;
    return Offset(x, y);
  }
}
