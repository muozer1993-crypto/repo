import 'dart:ui';

import '../../../core/time/time_window.dart';

/// Distractor category. Mapped to the persisted string form in
/// [distractorCategoryId]. The [absent] case means "no distractors in
/// this variant" — used for level 0 where the patient is still
/// learning the scene layout.
enum DistractorCategory { absent, far, near, functional }

String distractorCategoryId(DistractorCategory c) => switch (c) {
      DistractorCategory.absent => 'absent',
      DistractorCategory.far => 'far',
      DistractorCategory.near => 'near',
      DistractorCategory.functional => 'functional',
    };

DistractorCategory? distractorCategoryFromId(String? id) => switch (id) {
      'absent' => DistractorCategory.absent,
      'far' => DistractorCategory.far,
      'near' => DistractorCategory.near,
      'functional' => DistractorCategory.functional,
      _ => null,
    };

/// A persistent slot on the scene background. Position is stored in
/// unit-space ([0..1]) so the same JSON drives phones, tablets, and
/// landscape/portrait equally.
///
/// Slots do not respond to taps — they are visual hints to the patient
/// about where the item should end up. The tap target is the
/// [SceneItem] tile in the tray; after a correct tap the item
/// animates into its accepted slot.
class SceneSlot {
  const SceneSlot({
    required this.id,
    required this.relativeRect,
    required this.acceptedItemId,
    required this.labelTr,
  });

  final String id;

  /// x, y, w, h in 0..1 relative to the scene background.
  final Rect relativeRect;

  final String acceptedItemId;

  /// Accessible label, read by screen readers and also serves as the
  /// tooltip when the hint timer fires.
  final String labelTr;
}

/// A tappable item in the tray.
///
/// Either a target (has an [acceptedSlotId]) or a distractor
/// (distractor=true, acceptedSlotId=null, distractorCategory set).
class SceneItem {
  const SceneItem({
    required this.id,
    required this.assetPath,
    required this.audioLabelPath,
    required this.labelTr,
    this.acceptedSlotId,
    this.distractor = false,
    this.distractorCategory,
    this.sequenceOrder,
  });

  final String id;
  final String assetPath;
  final String audioLabelPath;
  final String labelTr;

  /// Null iff [distractor] is true.
  final String? acceptedSlotId;

  final bool distractor;

  final DistractorCategory? distractorCategory;

  /// 1-based position when the enclosing [DifficultyVariant] has
  /// `sequenceRequired: true`. Null otherwise.
  final int? sequenceOrder;
}

/// A single difficulty variant of a scene.
///
/// Every scene ships with five variants (level 0..4). The scheduler
/// picks the variant matching the patient's current
/// [ScheduleEntry.difficultyLevel]; the level can change on a per-
/// session basis without moving to a different scene.
class DifficultyVariant {
  const DifficultyVariant({
    required this.level,
    required this.distractorMode,
    required this.sequenceRequired,
    required this.items,
  });

  /// 0..4. Maps to the index in [Scene.variants].
  final int level;

  /// Category of distractors present in this variant. Used by the
  /// [PlacementEvent] context so reports can aggregate by category.
  final DistractorCategory distractorMode;

  /// If true, items must be tapped in [SceneItem.sequenceOrder]. Early
  /// taps on the correct item but in the wrong order are rejected
  /// errorlessly (wobble + errorCount++).
  final bool sequenceRequired;

  /// Target items first, then distractors. Order is irrelevant for
  /// rendering — the tray shuffles visually on mount, though the
  /// underlying list is stable so tests are deterministic.
  final List<SceneItem> items;

  int get targetCount => items.where((i) => !i.distractor).length;
}

/// An entry in [Scene.itemPool] — every item the scene can ever use
/// across variants and rotations. v2 scheduler draws from this pool to
/// produce day-specific [DifficultyVariant]s while honouring the
/// "no repeat combo in last 3 days" rule (see item pool rotation in
/// scheduler_controller).
class ItemPoolEntry {
  const ItemPoolEntry({
    required this.id,
    required this.assetPath,
    required this.audioLabelPath,
    required this.labelTr,
    required this.isTarget,
    this.defaultSlotId,
    this.distractorCategory,
  });

  final String id;
  final String assetPath;
  final String audioLabelPath;
  final String labelTr;

  /// True for items that belong in a slot; false for distractors.
  final bool isTarget;

  /// The canonical slot this target maps to. Null for distractors.
  /// Rotation may reassign targets across slots of equal semantic
  /// category, but v2's first cut uses this as the fixed slot.
  final String? defaultSlotId;

  /// Only meaningful when [isTarget] is false.
  final DistractorCategory? distractorCategory;
}

/// v2 — the four second-game types. Each scene ships exactly one
/// [Game2Config]; the scheduler may skip Game-2 on the earliest
/// learning-phase days to keep cognitive load low.
enum Game2Type { plateMatching, sequenceOrdering, quantityCounting, nextStepPlanning }

String game2TypeId(Game2Type t) => switch (t) {
      Game2Type.plateMatching => 'plate_matching',
      Game2Type.sequenceOrdering => 'sequence_ordering',
      Game2Type.quantityCounting => 'quantity_counting',
      Game2Type.nextStepPlanning => 'next_step_planning',
    };

Game2Type? game2TypeFromId(String? id) => switch (id) {
      'plate_matching' => Game2Type.plateMatching,
      'sequence_ordering' => Game2Type.sequenceOrdering,
      'quantity_counting' => Game2Type.quantityCounting,
      'next_step_planning' => Game2Type.nextStepPlanning,
      _ => null,
    };

/// v2 — a scene's second-game config. The scheduler passes this to
/// GameSessionController, which routes to the appropriate Game-2
/// widget after Game-1 completes.
///
/// Kept intentionally shallow: the four Game-2 widgets derive their
/// specific content from the scene's [itemPool] + current
/// [DifficultyVariant], not from per-type JSON. This avoids a
/// combinatorial explosion of content fields in each scene file.
class Game2Config {
  const Game2Config({
    required this.type,
    required this.instructionTr,
    required this.instructionAudioPath,
  });

  final Game2Type type;
  final String instructionTr;
  final String instructionAudioPath;
}

/// v2 — "calming" bonus plays offered after a successful scene OR at
/// night. Errors and timers do not exist here; the only metric is
/// whether the patient engaged (BonusPlayEvent.finishedAt != null).
enum BonusType { findItem, tapSequence, pairMatch, freeExplore }

String bonusTypeId(BonusType t) => switch (t) {
      BonusType.findItem => 'find_item',
      BonusType.tapSequence => 'tap_sequence',
      BonusType.pairMatch => 'pair_match',
      BonusType.freeExplore => 'free_explore',
    };

BonusType? bonusTypeFromId(String? id) => switch (id) {
      'find_item' => BonusType.findItem,
      'tap_sequence' => BonusType.tapSequence,
      'pair_match' => BonusType.pairMatch,
      'free_explore' => BonusType.freeExplore,
      _ => null,
    };

/// v2 — a standalone bonus scene. Loaded separately from [Scene] via
/// [SceneRepository.bonusById]; referenced by [Scene.bonusSceneId]
/// and by the night-bonus rotation (day-of-week → bonusSceneId).
class BonusScene {
  const BonusScene({
    required this.id,
    required this.bonusType,
    required this.titleTr,
    required this.instructionTr,
    required this.instructionAudioPath,
    required this.backgroundAsset,
    required this.itemPool,
    this.nightVariant = false,
  });

  final String id;
  final BonusType bonusType;
  final String titleTr;
  final String instructionTr;
  final String instructionAudioPath;
  final String backgroundAsset;

  /// Reusable items for this bonus. Bonus widgets pick a random subset
  /// each play; no error tracking, so asset-path correctness is what
  /// matters most here.
  final List<ItemPoolEntry> itemPool;

  /// True for scenes used during the 23:00–06:00 "rahatlatıcı" window.
  /// Night-bonus scenes are always available; dilim-bonus scenes only
  /// appear on the second entry of the window.
  final bool nightVariant;
}

/// A themed ADL scene: one background, one set of slots, several
/// difficulty variants.
///
/// v2 additions: [itemPool] (scheduler rotation source), [game2]
/// (second game after Game-1), [bonusSceneId] (linked bonus scene).
/// All three are optional so v1 scene files parse cleanly.
class Scene {
  const Scene({
    required this.id,
    required this.titleTr,
    required this.instructionTr,
    required this.instructionAudioPath,
    required this.window,
    required this.backgroundAsset,
    required this.slots,
    required this.variants,
    this.itemPool = const [],
    this.game2,
    this.bonusSceneId,
  });

  final String id;
  final String titleTr;
  final String instructionTr;
  final String instructionAudioPath;
  final TimeWindow window;
  final String backgroundAsset;
  final List<SceneSlot> slots;

  /// Indexed by difficulty level (0..4). A well-formed scene has
  /// exactly 5 entries.
  final List<DifficultyVariant> variants;

  /// v2 — rotation source. Empty for v1-only scenes.
  final List<ItemPoolEntry> itemPool;

  /// v2 — second-game config. Null for v1-only scenes.
  final Game2Config? game2;

  /// v2 — linked bonus scene id. Null for v1-only scenes.
  final String? bonusSceneId;

  DifficultyVariant variantFor(int difficultyLevel) {
    final i = difficultyLevel.clamp(0, variants.length - 1);
    return variants[i];
  }
}
