import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_theme.dart';
import '../../../../core/theme/motion.dart';
import '../../domain/scene.dart';

/// Single tappable tile in the tray.
///
/// When the patient taps, the parent scene board evaluates the tap
/// (via SceneController.onTap). Depending on the outcome this widget
/// either plays a wobble-in-place animation (distractor or wrong
/// sequence) or fades out while the FlyingItemOverlay animates the
/// item to its slot.
class SceneItemTile extends ConsumerStatefulWidget {
  const SceneItemTile({
    required this.item,
    required this.onTap,
    required this.placed,
    this.hinted = false,
    super.key,
  });

  final SceneItem item;
  final VoidCallback onTap;
  final bool placed;
  final bool hinted;

  @override
  ConsumerState<SceneItemTile> createState() => SceneItemTileState();
}

class SceneItemTileState extends ConsumerState<SceneItemTile>
    with TickerProviderStateMixin {
  late final AnimationController _wobbleController;
  late final AnimationController _pulseController;

  @override
  void initState() {
    super.initState();
    _wobbleController = AnimationController(
      vsync: this,
      duration: MotionDurations.wobble,
    );
    _pulseController = AnimationController(
      vsync: this,
      duration: MotionDurations.hintPulsePeriod,
    );
  }

  @override
  void didUpdateWidget(covariant SceneItemTile old) {
    super.didUpdateWidget(old);
    if (widget.hinted && !old.hinted) {
      _pulseController.repeat(reverse: true);
    } else if (!widget.hinted && old.hinted) {
      _pulseController.stop();
      _pulseController.value = 0;
    }
  }

  @override
  void dispose() {
    _wobbleController.dispose();
    _pulseController.dispose();
    super.dispose();
  }

  /// Called by the parent when the outcome is distractor or
  /// wrongSequence — triggers a short wobble.
  Future<void> wobble() async {
    final reduced = ref.read(reducedMotionProvider);
    if (reduced) return;
    _wobbleController.value = 0;
    await _wobbleController.forward();
    _wobbleController.value = 0;
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 200),
      opacity: widget.placed ? 0 : 1,
      child: GestureDetector(
        onTap: widget.placed ? null : widget.onTap,
        child: AnimatedBuilder(
          animation:
              Listenable.merge([_wobbleController, _pulseController]),
          builder: (context, _) {
            final wobbleOffset = _wobbleController.value == 0
                ? 0.0
                : (_wobbleController.value < 0.5
                        ? _wobbleController.value
                        : 1 - _wobbleController.value) *
                    12;
            final pulseScale = widget.hinted
                ? 1.0 + 0.06 * _pulseController.value
                : 1.0;
            return Transform.translate(
              offset: Offset(wobbleOffset, 0),
              child: Transform.scale(
                scale: pulseScale,
                child: _tile(context),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _tile(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: widget.hinted
                ? AppColors.hintPulse
                : Colors.black.withValues(alpha: 0.08),
            blurRadius: widget.hinted ? 16 : 6,
            spreadRadius: widget.hinted ? 2 : 0,
            offset: const Offset(0, 2),
          ),
        ],
        border: Border.all(
          color: widget.hinted
              ? AppColors.acceptGlow
              : AppColors.slotOutline.withValues(alpha: 0.5),
          width: widget.hinted ? 3 : 1,
        ),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Expanded(
            child: Image.asset(
              widget.item.assetPath,
              fit: BoxFit.contain,
              errorBuilder: (_, __, ___) => const Icon(
                Icons.image_outlined,
                size: 48,
                color: AppColors.textMuted,
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            widget.item.labelTr,
            style: const TextStyle(
              fontSize: 20,
              color: AppColors.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}
