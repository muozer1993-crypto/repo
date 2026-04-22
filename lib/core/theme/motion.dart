import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Reduced-motion preference.
///
/// Source of truth is the patient's profile ([PatientProfile.reducedMotion]).
/// Widgets should consume [reducedMotionProvider] rather than reading the
/// profile directly.
final reducedMotionProvider = StateProvider<bool>((_) => false);

/// Animation durations — halved when reduced-motion is on.
@immutable
class MotionDurations {
  const MotionDurations._();

  static const Duration itemFly = Duration(milliseconds: 600);
  static const Duration itemFlyReduced = Duration(milliseconds: 250);

  static const Duration wobble = Duration(milliseconds: 200);
  static const Duration wobbleReduced = Duration.zero;

  static const Duration slotAccept = Duration(milliseconds: 350);
  static const Duration slotAcceptReduced = Duration(milliseconds: 150);

  static const Duration celebrationFade = Duration(milliseconds: 500);
  static const Duration celebrationFadeReduced = Duration(milliseconds: 200);

  static const Duration hintPulsePeriod = Duration(milliseconds: 1400);
}

Duration pickMotion({
  required Duration full,
  required Duration reduced,
  required bool isReduced,
}) =>
    isReduced ? reduced : full;
