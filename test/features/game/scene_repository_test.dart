import 'package:ergoterapi/core/time/time_window.dart';
import 'package:ergoterapi/features/game/data/scene_repository.dart';
import 'package:ergoterapi/features/game/domain/scene.dart';
import 'package:flutter_test/flutter_test.dart';

/// Stub loader that serves pre-defined fixtures keyed by asset path.
class _StubLoader {
  _StubLoader(this._fixtures);
  final Map<String, String> _fixtures;

  Future<String> call(String path) async {
    final v = _fixtures[path];
    if (v == null) throw StateError('no fixture for $path');
    return v;
  }
}

const _sabahFixture = '''
{
  "id": "sabah_kahvalti",
  "titleTr": "Kahvaltı Hazırla",
  "instructionTr": "Masayı hazırla.",
  "instructionAudioPath": "assets/audio/instructions/sabah.wav",
  "window": "sabah",
  "backgroundAsset": "assets/images/scenes/sabah/masa_bg.png",
  "slots": [
    {"id":"slot_peynir","rect":[0.1,0.5,0.2,0.2],"acceptedItemId":"peynir","labelTr":"peynir tabağı"},
    {"id":"slot_cay","rect":[0.4,0.5,0.2,0.2],"acceptedItemId":"cay","labelTr":"çay bardağı"}
  ],
  "variants": [
    {
      "level": 0,
      "distractorMode": "absent",
      "sequenceRequired": false,
      "items": [
        {"id":"peynir","assetPath":"peynir.png","audioLabelPath":"peynir.wav","labelTr":"peynir","acceptedSlotId":"slot_peynir"},
        {"id":"cay","assetPath":"cay.png","audioLabelPath":"cay.wav","labelTr":"çay","acceptedSlotId":"slot_cay"}
      ]
    },
    {
      "level": 1,
      "distractorMode": "far",
      "sequenceRequired": false,
      "items": [
        {"id":"peynir","assetPath":"peynir.png","audioLabelPath":"peynir.wav","labelTr":"peynir","acceptedSlotId":"slot_peynir"},
        {"id":"cay","assetPath":"cay.png","audioLabelPath":"cay.wav","labelTr":"çay","acceptedSlotId":"slot_cay"},
        {"id":"terlik","assetPath":"terlik.png","audioLabelPath":"terlik.wav","labelTr":"terlik","distractor":true,"distractorCategory":"far"}
      ]
    },
    {
      "level": 3,
      "distractorMode": "near",
      "sequenceRequired": true,
      "items": [
        {"id":"peynir","assetPath":"peynir.png","audioLabelPath":"peynir.wav","labelTr":"peynir","acceptedSlotId":"slot_peynir","sequenceOrder":1},
        {"id":"cay","assetPath":"cay.png","audioLabelPath":"cay.wav","labelTr":"çay","acceptedSlotId":"slot_cay","sequenceOrder":2},
        {"id":"corba","assetPath":"corba.png","audioLabelPath":"corba.wav","labelTr":"çorba","distractor":true,"distractorCategory":"near"}
      ]
    }
  ]
}
''';

void main() {
  group('SceneRepository', () {
    test('parses top-level scene fields', () async {
      final repo = SceneRepository(
        _StubLoader({
          'assets/scenes/sabah_kahvalti.json': _sabahFixture,
          'assets/scenes/oglen_ogle_yemegi.json': _minimalFixture('oglen'),
          'assets/scenes/ikindi_cay_saati.json': _minimalFixture('ikindi'),
          'assets/scenes/aksam_yatak_duzeni.json': _minimalFixture('aksam'),
        }).call,
      );
      final scene = await repo.byId('sabah_kahvalti');

      expect(scene, isNotNull);
      expect(scene!.titleTr, 'Kahvaltı Hazırla');
      expect(scene.window, TimeWindow.sabah);
      expect(scene.slots.length, 2);
      expect(scene.variants.length, 3);
    });

    test('distractor items keep category, no acceptedSlotId', () async {
      final repo = _repoWithSabah();
      final scene = await repo.byId('sabah_kahvalti');
      final l1 = scene!.variants.firstWhere((v) => v.level == 1);
      final terlik = l1.items.firstWhere((i) => i.id == 'terlik');

      expect(terlik.distractor, isTrue);
      expect(terlik.distractorCategory, DistractorCategory.far);
      expect(terlik.acceptedSlotId, isNull);
    });

    test('target items in a sequenceRequired variant have sequenceOrder',
        () async {
      final repo = _repoWithSabah();
      final scene = await repo.byId('sabah_kahvalti');
      final l3 = scene!.variants.firstWhere((v) => v.level == 3);

      expect(l3.sequenceRequired, isTrue);
      final peynir = l3.items.firstWhere((i) => i.id == 'peynir');
      expect(peynir.sequenceOrder, 1);
      final cay = l3.items.firstWhere((i) => i.id == 'cay');
      expect(cay.sequenceOrder, 2);
    });

    test('byWindow returns the scene matching the enum', () async {
      final repo = _repoWithSabah();
      final scene = await repo.byWindow(TimeWindow.sabah);
      expect(scene?.id, 'sabah_kahvalti');
    });

    test('variantFor clamps out-of-range indexes', () async {
      final repo = _repoWithSabah();
      final scene = await repo.byId('sabah_kahvalti');
      expect(scene!.variantFor(-1).level, 0);
      expect(scene.variantFor(99).level, 3); // only 0,1,3 in fixture
    });
  });
}

SceneRepository _repoWithSabah() {
  return SceneRepository(
    _StubLoader({
      'assets/scenes/sabah_kahvalti.json': _sabahFixture,
      'assets/scenes/oglen_ogle_yemegi.json': _minimalFixture('oglen'),
      'assets/scenes/ikindi_cay_saati.json': _minimalFixture('ikindi'),
      'assets/scenes/aksam_yatak_duzeni.json': _minimalFixture('aksam'),
    }).call,
  );
}

String _minimalFixture(String window) => '''
{
  "id": "${window}_x",
  "titleTr": "X",
  "instructionTr": "X",
  "instructionAudioPath": "x.wav",
  "window": "$window",
  "backgroundAsset": "x.png",
  "slots": [],
  "variants": [
    {"level":0,"distractorMode":"absent","sequenceRequired":false,"items":[]}
  ]
}
''';
