import 'dart:convert';
import 'dart:ui';

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/time/time_window.dart';
import '../domain/scene.dart';

/// Four dilim scene JSONs we ship in the asset bundle. One per time
/// window.
const _sceneAssets = <String>[
  'assets/scenes/sabah_kahvalti.json',
  'assets/scenes/oglen_ogle_yemegi.json',
  'assets/scenes/ikindi_cay_saati.json',
  'assets/scenes/aksam_yatak_duzeni.json',
];

/// v2 — bonus scene JSONs. Kept in a parallel list so that the dilim
/// scene loader path (hot on app start) does not have to sift bonuses
/// out.
const _bonusAssets = <String>[
  'assets/scenes/bonus/bonus_sabah_pair.json',
  'assets/scenes/bonus/bonus_oglen_find.json',
  'assets/scenes/bonus/bonus_ikindi_tap.json',
  'assets/scenes/bonus/bonus_aksam_explore.json',
  'assets/scenes/bonus/bonus_night_explore.json',
];

/// Loads + caches all bundled scenes.
///
/// We parse eagerly at app start since it's only four small JSON
/// files and the scene list never changes at runtime. A lazy per-id
/// loader would just add a Future to the hot path of "launch the game".
class SceneRepository {
  SceneRepository(this._loader);

  final Future<String> Function(String assetPath) _loader;

  List<Scene>? _cache;
  List<BonusScene>? _bonusCache;

  Future<List<Scene>> loadAll() async {
    if (_cache != null) return _cache!;
    final jsons = await Future.wait(_sceneAssets.map(_loader));
    _cache = jsons.map(_parseScene).toList(growable: false);
    return _cache!;
  }

  Future<Scene?> byId(String id) async {
    final all = await loadAll();
    for (final s in all) {
      if (s.id == id) return s;
    }
    return null;
  }

  Future<Scene?> byWindow(TimeWindow window) async {
    final all = await loadAll();
    for (final s in all) {
      if (s.window == window) return s;
    }
    return null;
  }

  /// v2 — load every bonus scene in the bundle. Missing assets are
  /// skipped silently so a partial bonus roll-out does not break the
  /// app.
  Future<List<BonusScene>> loadAllBonus() async {
    if (_bonusCache != null) return _bonusCache!;
    final raws = <String>[];
    for (final path in _bonusAssets) {
      try {
        raws.add(await _loader(path));
      } catch (_) {
        // Bonus asset not shipped yet — skip.
      }
    }
    _bonusCache = raws.map(_parseBonusScene).toList(growable: false);
    return _bonusCache!;
  }

  Future<BonusScene?> bonusById(String id) async {
    final all = await loadAllBonus();
    for (final b in all) {
      if (b.id == id) return b;
    }
    return null;
  }
}

/// Exposed so tests can swap in a StringMap loader without hitting
/// rootBundle.
typedef SceneAssetLoader = Future<String> Function(String assetPath);

final sceneRepositoryProvider = Provider<SceneRepository>((ref) {
  return SceneRepository(rootBundle.loadString);
});

// ---------------------------------------------------------------------------
// Parser. Kept as free functions so parsing is testable without an Isar
// instance or a Riverpod container.
// ---------------------------------------------------------------------------

Scene _parseScene(String raw) {
  final j = json.decode(raw) as Map<String, dynamic>;
  final windowId = j['window'] as String;
  final window = timeWindowFromId(windowId);
  if (window == null) {
    throw FormatException('Scene "${j['id']}" has unknown window id '
        '"$windowId"');
  }
  final poolJson = j['itemPool'] as List?;
  final game2Json = j['game2'] as Map<String, dynamic>?;
  return Scene(
    id: j['id'] as String,
    titleTr: j['titleTr'] as String,
    instructionTr: j['instructionTr'] as String,
    instructionAudioPath: j['instructionAudioPath'] as String,
    window: window,
    backgroundAsset: j['backgroundAsset'] as String,
    slots: (j['slots'] as List).cast<Map<String, dynamic>>().map(_parseSlot)
        .toList(growable: false),
    variants: (j['variants'] as List)
        .cast<Map<String, dynamic>>()
        .map(_parseVariant)
        .toList(growable: false),
    itemPool: poolJson == null
        ? const []
        : poolJson
            .cast<Map<String, dynamic>>()
            .map(_parsePoolEntry)
            .toList(growable: false),
    game2: game2Json == null ? null : _parseGame2(game2Json),
    bonusSceneId: j['bonusSceneId'] as String?,
  );
}

ItemPoolEntry _parsePoolEntry(Map<String, dynamic> j) {
  final isTarget = j['isTarget'] as bool? ?? false;
  return ItemPoolEntry(
    id: j['id'] as String,
    assetPath: j['assetPath'] as String,
    audioLabelPath: j['audioLabelPath'] as String,
    labelTr: j['labelTr'] as String,
    isTarget: isTarget,
    defaultSlotId: isTarget ? j['defaultSlotId'] as String? : null,
    distractorCategory: isTarget
        ? null
        : distractorCategoryFromId(j['distractorCategory'] as String?),
  );
}

Game2Config _parseGame2(Map<String, dynamic> j) {
  final type = game2TypeFromId(j['type'] as String?);
  if (type == null) {
    throw FormatException('Unknown game2.type "${j['type']}"');
  }
  return Game2Config(
    type: type,
    instructionTr: j['instructionTr'] as String,
    instructionAudioPath: j['instructionAudioPath'] as String,
  );
}

BonusScene _parseBonusScene(String raw) {
  final j = json.decode(raw) as Map<String, dynamic>;
  final typeId = j['bonusType'] as String?;
  final type = bonusTypeFromId(typeId);
  if (type == null) {
    throw FormatException('Unknown bonusType "$typeId" in bonus scene '
        '"${j['id']}"');
  }
  final poolJson = j['itemPool'] as List? ?? const [];
  return BonusScene(
    id: j['id'] as String,
    bonusType: type,
    titleTr: j['titleTr'] as String,
    instructionTr: j['instructionTr'] as String,
    instructionAudioPath: j['instructionAudioPath'] as String,
    backgroundAsset: j['backgroundAsset'] as String,
    itemPool: poolJson
        .cast<Map<String, dynamic>>()
        .map(_parsePoolEntry)
        .toList(growable: false),
    nightVariant: j['nightVariant'] as bool? ?? false,
  );
}

SceneSlot _parseSlot(Map<String, dynamic> j) {
  final r = (j['rect'] as List).cast<num>();
  return SceneSlot(
    id: j['id'] as String,
    relativeRect: Rect.fromLTWH(
      r[0].toDouble(),
      r[1].toDouble(),
      r[2].toDouble(),
      r[3].toDouble(),
    ),
    acceptedItemId: j['acceptedItemId'] as String,
    labelTr: j['labelTr'] as String,
    emptyAssetPath: j['emptyAssetPath'] as String?,
  );
}

DifficultyVariant _parseVariant(Map<String, dynamic> j) {
  final cat = distractorCategoryFromId(j['distractorMode'] as String?);
  if (cat == null) {
    throw FormatException('Unknown distractorMode "${j['distractorMode']}"');
  }
  return DifficultyVariant(
    level: (j['level'] as num).toInt(),
    distractorMode: cat,
    sequenceRequired: j['sequenceRequired'] as bool,
    items: (j['items'] as List)
        .cast<Map<String, dynamic>>()
        .map(_parseItem)
        .toList(growable: false),
  );
}

SceneItem _parseItem(Map<String, dynamic> j) {
  final distractor = (j['distractor'] as bool?) ?? false;
  final cat = distractorCategoryFromId(j['distractorCategory'] as String?);
  final sequenceOrder = (j['sequenceOrder'] as num?)?.toInt();
  return SceneItem(
    id: j['id'] as String,
    assetPath: j['assetPath'] as String,
    audioLabelPath: j['audioLabelPath'] as String,
    labelTr: j['labelTr'] as String,
    acceptedSlotId: distractor ? null : j['acceptedSlotId'] as String?,
    distractor: distractor,
    distractorCategory: cat,
    sequenceOrder: sequenceOrder,
  );
}
