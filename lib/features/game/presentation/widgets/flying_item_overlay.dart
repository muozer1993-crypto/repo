import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/motion.dart';

/// Curves an item from its tray position to the accepted slot using a
/// simple quadratic Bezier with a peak above the midpoint — feels
/// livelier than a straight line without being distracting.
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
        final pos = _quadratic(widget.start, widget.end, t);
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

  Offset _quadratic(Offset a, Offset b, double t) {
    // Control point lifted above midpoint so the item arcs upward.
    final control = Offset(
      (a.dx + b.dx) / 2,
      (a.dy + b.dy) / 2 - 60,
    );
    final x = (1 - t) * (1 - t) * a.dx +
        2 * (1 - t) * t * control.dx +
        t * t * b.dx;
    final y = (1 - t) * (1 - t) * a.dy +
        2 * (1 - t) * t * control.dy +
        t * t * b.dy;
    return Offset(x, y);
  }
}
