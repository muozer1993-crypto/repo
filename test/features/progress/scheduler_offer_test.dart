import 'package:ergoterapi/core/time/time_window.dart';
import 'package:ergoterapi/features/game/domain/scene.dart';
import 'package:ergoterapi/features/progress/application/scheduler_controller.dart';
import 'package:flutter_test/flutter_test.dart';

Scene _sceneWith({
  String? bonusSceneId,
  Game2Type type = Game2Type.plateMatching,
}) {
  return Scene(
    id: 'sabah_kahvalti',
    titleTr: 'Kahvaltı',
    instructionTr: 'Hazırla',
    instructionAudioPath: 'x.wav',
    window: TimeWindow.sabah,
    backgroundAsset: 'bg.png',
    slots: const [],
    variants: [
      DifficultyVariant(
        level: 0,
        distractorMode: DistractorCategory.absent,
        sequenceRequired: false,
        items: const [],
      ),
    ],
    itemPool: const [],
    game2: Game2Config(
      type: type,
      instructionTr: 'x',
      instructionAudioPath: 'x.wav',
    ),
    bonusSceneId: bonusSceneId,
  );
}

void main() {
  group('shouldOfferBonus', () {
    test('no bonus configured → never offer', () {
      final result = shouldOfferBonus(
        scene: _sceneWith(bonusSceneId: null),
        window: TimeWindow.sabah,
        today: const TodaySessionSnapshot(
          completedByWindow: {TimeWindow.sabah: 3},
          bonusPlayedByWindow: {},
          game2TypesPlayed: {},
        ),
      );
      expect(result, isNull);
    });

    test('first entry of the day → no offer yet', () {
      final result = shouldOfferBonus(
        scene: _sceneWith(bonusSceneId: 'bonus_sabah_pair'),
        window: TimeWindow.sabah,
        today: const TodaySessionSnapshot(
          completedByWindow: {},
          bonusPlayedByWindow: {},
          game2TypesPlayed: {},
        ),
      );
      expect(result, isNull);
    });

    test('second entry, bonus not played → offer the scene bonus', () {
      final result = shouldOfferBonus(
        scene: _sceneWith(bonusSceneId: 'bonus_sabah_pair'),
        window: TimeWindow.sabah,
        today: const TodaySessionSnapshot(
          completedByWindow: {TimeWindow.sabah: 1},
          bonusPlayedByWindow: {},
          game2TypesPlayed: {Game2Type.plateMatching},
        ),
      );
      expect(result, 'bonus_sabah_pair');
    });

    test('bonus already played today → don\'t re-offer', () {
      final result = shouldOfferBonus(
        scene: _sceneWith(bonusSceneId: 'bonus_sabah_pair'),
        window: TimeWindow.sabah,
        today: const TodaySessionSnapshot(
          completedByWindow: {TimeWindow.sabah: 1},
          bonusPlayedByWindow: {TimeWindow.sabah: true},
          game2TypesPlayed: {},
        ),
      );
      expect(result, isNull);
    });
  });
}
