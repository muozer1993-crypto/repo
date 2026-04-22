import 'dart:convert';
import 'dart:ui';

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/time/time_window.dart';
import '../domain/scene.dart';

/// Four scene JSONs we ship in the asset bundle. One per time window.
const _sceneAssets = <String>[
  'assets/scenes/sabah_kahvalti.json',
  'assets/scenes/oglen_ogle_yemegi.json',
  'assets/scenes/ikindi_cay_saati.json',
  'assets/scenes/aksam_yatak_duzeni.json',
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
