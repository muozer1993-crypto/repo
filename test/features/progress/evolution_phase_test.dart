import 'package:ergoterapi/features/progress/application/spaced_retrieval.dart';
import 'package:ergoterapi/features/progress/domain/schedule_entry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('evolution / learning phase', () {
    final created = DateTime.utc(2026, 4, 22, 10);

    test('learning phase: clean run does not advance difficulty', () {
      final entry = ScheduleEntry()
        ..id = 1
        ..sceneId = 'sabah_kahvalti'
        ..srInterval = 0
        ..difficultyLevel = 0
        ..cleanRunStreak = 1; // streak gate satisfied

      final updated = onCompletion(
        entry,
        errorCount: 0,
        now: created.add(const Duration(hours: 24)),
        lockDifficulty: isInLearningPhase(
          profileCreatedAt: created,
          now: created.add(const Duration(hours: 24)),
        ),
      );

      expect(updated.difficultyLevel, 0);
      // srInterval still advances because frequency is independent.
      expect(updated.srInterval, 1);
    });

    test('post-learning (day 4): same clean run advances difficulty', () {
      final entry = ScheduleEntry()
        ..id = 1
        ..sceneId = 'sabah_kahvalti'
        ..srInterval = 0
        ..difficultyLevel = 0
        ..cleanRunStreak = 1;

      final now = created.add(const Duration(days: 4));
      final updated = onCompletion(
        entry,
        errorCount: 0,
        now: now,
        lockDifficulty: isInLearningPhase(
          profileCreatedAt: created,
          now: now,
        ),
      );

      expect(updated.difficultyLevel, 1);
      expect(updated.srInterval, 1);
    });

    test('learning phase: high-error session rolls back srInterval but not '
        'difficulty', () {
      final entry = ScheduleEntry()
        ..id = 1
        ..sceneId = 'sabah_kahvalti'
        ..srInterval = 2
        ..difficultyLevel = 2
        ..cleanRunStreak = 0;

      final updated = onCompletion(
        entry,
        errorCount: 5,
        now: created.add(const Duration(hours: 12)),
        lockDifficulty: true,
      );

      expect(updated.difficultyLevel, 2); // pinned
      expect(updated.srInterval, 1); // rolled back one
    });
  });
}
