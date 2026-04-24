import 'package:ergoterapi/core/time/time_window.dart';
import 'package:ergoterapi/features/progress/application/scheduler_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('bonusSceneIdFor', () {
    test('each time window resolves to its dedicated bonus scene', () {
      final date = DateTime.utc(2026, 4, 22);
      expect(
        bonusSceneIdFor(window: TimeWindow.sabah, date: date),
        'bonus_sabah_pair',
      );
      expect(
        bonusSceneIdFor(window: TimeWindow.oglen, date: date),
        'bonus_oglen_find',
      );
      expect(
        bonusSceneIdFor(window: TimeWindow.ikindi, date: date),
        'bonus_ikindi_tap',
      );
      expect(
        bonusSceneIdFor(window: TimeWindow.aksam, date: date),
        'bonus_aksam_explore',
      );
    });

    test('dinlenme resolves to the night-variant bonus', () {
      expect(
        bonusSceneIdFor(
          window: TimeWindow.dinlenme,
          date: DateTime.utc(2026, 4, 22),
        ),
        'bonus_night_explore',
      );
    });

    test('rotation is deterministic across repeat calls on same inputs', () {
      final date = DateTime.utc(2026, 4, 22);
      final a = bonusSceneIdFor(window: TimeWindow.sabah, date: date);
      final b = bonusSceneIdFor(window: TimeWindow.sabah, date: date);
      expect(a, b);
    });
  });
}
