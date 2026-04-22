import 'package:ergoterapi/core/time/time_window.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('windowFor', () {
    test('exhaustive per-hour mapping', () {
      final expected = <int, TimeWindow>{
        0: TimeWindow.dinlenme,
        1: TimeWindow.dinlenme,
        2: TimeWindow.dinlenme,
        3: TimeWindow.dinlenme,
        4: TimeWindow.dinlenme,
        5: TimeWindow.dinlenme,
        6: TimeWindow.sabah,
        7: TimeWindow.sabah,
        8: TimeWindow.sabah,
        9: TimeWindow.sabah,
        10: TimeWindow.sabah,
        11: TimeWindow.oglen,
        12: TimeWindow.oglen,
        13: TimeWindow.oglen,
        14: TimeWindow.oglen,
        15: TimeWindow.ikindi,
        16: TimeWindow.ikindi,
        17: TimeWindow.ikindi,
        18: TimeWindow.ikindi,
        19: TimeWindow.aksam,
        20: TimeWindow.aksam,
        21: TimeWindow.aksam,
        22: TimeWindow.aksam,
        23: TimeWindow.dinlenme,
      };
      expected.forEach((hour, window) {
        final now = DateTime(2026, 4, 22, hour, 30);
        expect(
          windowFor(now),
          window,
          reason: 'hour=$hour expected=$window got=${windowFor(now)}',
        );
      });
    });

    test('boundary minute 0 matches hour start (inclusive)', () {
      expect(windowFor(DateTime(2026, 4, 22, 6, 0)), TimeWindow.sabah);
      expect(windowFor(DateTime(2026, 4, 22, 11, 0)), TimeWindow.oglen);
      expect(windowFor(DateTime(2026, 4, 22, 15, 0)), TimeWindow.ikindi);
      expect(windowFor(DateTime(2026, 4, 22, 19, 0)), TimeWindow.aksam);
      expect(windowFor(DateTime(2026, 4, 22, 23, 0)), TimeWindow.dinlenme);
    });

    test('boundary minute 59 stays in the same window (exclusive upper)', () {
      expect(windowFor(DateTime(2026, 4, 22, 10, 59)), TimeWindow.sabah);
      expect(windowFor(DateTime(2026, 4, 22, 14, 59)), TimeWindow.oglen);
      expect(windowFor(DateTime(2026, 4, 22, 18, 59)), TimeWindow.ikindi);
      expect(windowFor(DateTime(2026, 4, 22, 22, 59)), TimeWindow.aksam);
      expect(windowFor(DateTime(2026, 4, 22, 5, 59)), TimeWindow.dinlenme);
    });
  });

  group('timeWindowId round-trip', () {
    test('every enum value serializes and parses back', () {
      for (final w in TimeWindow.values) {
        expect(timeWindowFromId(timeWindowId(w)), w);
      }
    });

    test('unknown id returns null', () {
      expect(timeWindowFromId('gece'), isNull);
      expect(timeWindowFromId(''), isNull);
    });
  });
}
