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

/// A themed ADL scene: one background, one set of slots, several
/// difficulty variants.
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

  DifficultyVariant variantFor(int difficultyLevel) {
    final i = difficultyLevel.clamp(0, variants.length - 1);
    return variants[i];
  }
}
