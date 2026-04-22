import 'package:ergoterapi/features/progress/application/spaced_retrieval.dart';
import 'package:ergoterapi/features/progress/domain/schedule_entry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('nextInterval — frequency axis', () {
    test('clean run (0 errors) advances one stage', () {
      expect(nextInterval(0, errorCount: 0), 1);
      expect(nextInterval(2, errorCount: 1), 3);
      expect(nextInterval(3, errorCount: 0), 4);
    });

    test('high-error run (≥4 errors) rolls back one stage', () {
      expect(nextInterval(2, errorCount: 5), 1);
      expect(nextInterval(4, errorCount: 4), 3);
    });

    test('middling errors (2-3) stay put', () {
      expect(nextInterval(2, errorCount: 2), 2);
      expect(nextInterval(2, errorCount: 3), 2);
    });

    test('upper bound clamps at 4', () {
      expect(nextInterval(4, errorCount: 0), 4);
    });

    test('lower bound clamps at 0', () {
      expect(nextInterval(0, errorCount: 5), 0);
    });
  });

  group('nextDifficulty — within-scene difficulty axis', () {
    test(
      'clean run + streak ≥ 1 advances one level',
      () {
        expect(nextDifficulty(0, errorCount: 0, cleanRunStreak: 1), 1);
        expect(nextDifficulty(3, errorCount: 1, cleanRunStreak: 5), 4);
      },
    );

    test('clean run WITHOUT prior streak stays put', () {
      expect(nextDifficulty(2, errorCount: 0, cleanRunStreak: 0), 2);
    });

    test('≥ 4 errors roll back immediately (streak irrelevant)', () {
      expect(nextDifficulty(3, errorCount: 5, cleanRunStreak: 0), 2);
      expect(nextDifficulty(3, errorCount: 4, cleanRunStreak: 10), 2);
    });

    test('middling errors stay put', () {
      expect(nextDifficulty(2, errorCount: 2, cleanRunStreak: 5), 2);
      expect(nextDifficulty(2, errorCount: 3, cleanRunStreak: 5), 2);
    });

    test('bounds clamp', () {
      expect(nextDifficulty(4, errorCount: 0, cleanRunStreak: 1), 4);
      expect(nextDifficulty(0, errorCount: 5, cleanRunStreak: 0), 0);
    });
  });

  group('onCompletion — composed update', () {
    final fixed = DateTime.utc(2026, 4, 22, 10);

    ScheduleEntry make({
      required int srInterval,
      required int difficulty,
      required int streak,
    }) {
      return ScheduleEntry()
        ..id = 1
        ..sceneId = 'sabah_kahvalti'
        ..srInterval = srInterval
        ..difficultyLevel = difficulty
        ..cleanRunStreak = streak
        ..nextDueAt = fixed.subtract(const Duration(days: 1));
    }

    test(
      'clean run with no prior streak: interval advances, difficulty '
      'stays (streak gate), streak becomes 1, nextDueAt = +1d',
      () {
        final prev = make(srInterval: 0, difficulty: 0, streak: 0);

        final next = onCompletion(prev, errorCount: 0, now: fixed);

        expect(next.srInterval, 1);
        expect(next.difficultyLevel, 0);
        expect(next.cleanRunStreak, 1);
        expect(next.nextDueAt, fixed.add(const Duration(days: 3)));
        // Interval stage 1 → kIntervalDays[1] = 3 days.
      },
    );

    test(
      'clean run WITH prior streak: both axes advance, streak increments',
      () {
        final prev = make(srInterval: 1, difficulty: 2, streak: 1);

        final next = onCompletion(prev, errorCount: 1, now: fixed);

        expect(next.srInterval, 2);
        expect(next.difficultyLevel, 3);
        expect(next.cleanRunStreak, 2);
        expect(next.nextDueAt, fixed.add(const Duration(days: 7)));
      },
    );

    test(
      'high-error run: both axes roll back, streak resets to 0',
      () {
        final prev = make(srInterval: 3, difficulty: 3, streak: 4);

        final next = onCompletion(prev, errorCount: 5, now: fixed);

        expect(next.srInterval, 2);
        expect(next.difficultyLevel, 2);
        expect(next.cleanRunStreak, 0);
        expect(next.nextDueAt, fixed.add(const Duration(days: 7)));
      },
    );

    test('sceneId and id preserved across update', () {
      final prev = make(srInterval: 0, difficulty: 0, streak: 0);

      final next = onCompletion(prev, errorCount: 0, now: fixed);

      expect(next.sceneId, prev.sceneId);
      expect(next.id, prev.id);
    });
  });

  group('freshEntry', () {
    test('starts at 0/0/0, due immediately', () {
      final now = DateTime.utc(2026, 4, 22, 10);

      final e = freshEntry('scene_x', now: now);

      expect(e.srInterval, 0);
      expect(e.difficultyLevel, 0);
      expect(e.cleanRunStreak, 0);
      expect(e.nextDueAt, now);
      expect(e.lastCompletedAt, isNull);
    });
  });
}
