import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Injectable clock.
///
/// Widgets that depend on "now" MUST read through this provider rather than
/// calling [DateTime.now] directly, so tests can override the clock to a
/// fixed instant.
///
/// Test usage:
/// ```dart
/// ProviderContainer(overrides: [
///   clockProvider.overrideWithValue(() => DateTime(2026, 4, 22, 9)),
/// ]);
/// ```
///
/// The `--dart-define=DEBUG_HOUR=9` flag is also honored in debug builds
/// for quick manual testing of time-window behavior.
final clockProvider = Provider<DateTime Function()>((_) {
  const debugHour = String.fromEnvironment('DEBUG_HOUR');
  if (debugHour.isNotEmpty) {
    final hour = int.tryParse(debugHour);
    if (hour != null && hour >= 0 && hour < 24) {
      return () {
        final real = DateTime.now();
        return DateTime(real.year, real.month, real.day, hour, 0);
      };
    }
  }
  return DateTime.now;
});
