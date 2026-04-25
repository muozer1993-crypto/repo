import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/audio/audio_service.dart';
import '../../../../core/haptics/haptics_service.dart';
import '../../../../core/theme/app_theme.dart';
import '../../application/scene_controller.dart';
import '../../domain/scene.dart';
import 'flying_item_overlay.dart';
import 'scene_item_tile.dart';
import 'scene_slot.dart';

/// v2 — Game-1 board.
///
/// Top half is a "scene area" rendering the scene's [Scene.backgroundAsset]
/// (e.g. assets/images/scenes/sabah/masa_bg.png) with the slots
/// positioned absolutely on top of it via each [SceneSlot.relativeRect].
/// When the asset is missing the area falls back to a stylised
/// container (rounded corners, warm beige) so the layout is still
/// sensible during dev — patients/caregivers can drop in real PNGs
/// later without touching code.
///
/// Bottom half is a tray of tappable items. Tap → fly-to-slot
/// animation (handled by FlyingItemOverlay), errorless feedback for
/// distractor / wrong-sequence taps (handled by SceneItemTile.wobble).
class SceneBoard extends ConsumerStatefulWidget {
  const SceneBoard({super.key});

  @override
  ConsumerState<SceneBoard> createState() => _SceneBoardState();
}

class _SceneBoardState extends ConsumerState<SceneBoard> {
  final Map<String, GlobalKey> _itemKeys = {};
  final Map<String, GlobalKey> _slotKeys = {};
  final Map<String, GlobalKey<SceneItemTileState>> _tileStateKeys = {};
  final Map<String, _InFlight> _inFlight = {};

  @override
  Widget build(BuildContext context) {
    ref.listen<SceneState>(sceneControllerProvider, (prev, next) {
      final outcome = next.lastOutcome;
      final itemId = next.lastOutcomeItemId;
      if (outcome == null || itemId == null) return;
      if (outcome == TapOutcome.correct) {
        _startFlyTo(itemId);
      } else {
        _tileStateKeys[itemId]?.currentState?.wobble();
      }
      ref.read(sceneControllerProvider.notifier).clearLastOutcome();
    });

    final state = ref.watch(sceneControllerProvider);
    return Stack(
      children: [
        const Positioned.fill(
          child: ColoredBox(color: AppColors.background),
        ),
        Positioned.fill(
          child: Padding(
            // Top 96 leaves room for the labeled Çık/Dinle buttons +
            // instruction banner that ScenePlayerScreen overlays.
            padding: const EdgeInsets.fromLTRB(12, 96, 12, 12),
            child: Column(
              children: [
                // Top half — table/scene area with positioned slots.
                Expanded(
                  flex: 6,
                  child: _SceneArea(
                    state: state,
                    slotKeys: _slotKeys,
                    itemForSlot: _itemForSlot,
                  ),
                ),
                const SizedBox(height: 8),
                _SectionHeader(text: 'Yemeklere dokun'),
                const SizedBox(height: 6),
                // Bottom half — tray of items.
                Expanded(
                  flex: 4,
                  child: _trayRow(state),
                ),
              ],
            ),
          ),
        ),
        ..._inFlightOverlays(),
      ],
    );
  }

  Widget _trayRow(SceneState state) {
    final items = state.variant.items;
    final twoRows = items.length > 5;
    if (!twoRows) {
      return Row(
        children: items
            .map((item) => Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: _trayTile(state, item),
                  ),
                ))
            .toList(growable: false),
      );
    }
    final half = (items.length / 2).ceil();
    final top = items.sublist(0, half);
    final bottom = items.sublist(half);
    return Column(
      children: [
        Expanded(child: _trayRowRaw(state, top)),
        const SizedBox(height: 8),
        Expanded(child: _trayRowRaw(state, bottom)),
      ],
    );
  }

  Widget _trayRowRaw(SceneState state, List<SceneItem> row) {
    return Row(
      children: row
          .map((item) => Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: _trayTile(state, item),
                ),
              ))
          .toList(growable: false),
    );
  }

  Widget _trayTile(SceneState state, SceneItem item) {
    _itemKeys.putIfAbsent(item.id, GlobalKey.new);
    _tileStateKeys.putIfAbsent(
      item.id,
      GlobalKey<SceneItemTileState>.new,
    );
    return KeyedSubtree(
      key: _itemKeys[item.id],
      child: SceneItemTile(
        key: _tileStateKeys[item.id],
        item: item,
        placed: state.placedItemIds.contains(item.id),
        hinted: state.hintTargetItemId == item.id,
        onTap: () => _onTap(item),
      ),
    );
  }

  List<Widget> _inFlightOverlays() {
    return _inFlight.values.map((f) {
      return FlyingItemOverlay(
        key: ValueKey(f.itemId),
        assetPath: f.assetPath,
        start: f.start,
        end: f.end,
        size: f.size,
        onFinished: () {
          setState(() => _inFlight.remove(f.itemId));
        },
      );
    }).toList(growable: false);
  }

  void _onTap(SceneItem item) {
    final outcome = ref.read(sceneControllerProvider.notifier).onTap(item);
    if (outcome == TapOutcome.correct) {
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(hapticsServiceProvider).light();
    }
  }

  void _startFlyTo(String itemId) {
    final variant =
        ref.read(sceneControllerProvider.notifier).state.variant;
    final item = variant.items.firstWhere((i) => i.id == itemId);
    if (item.acceptedSlotId == null) return;

    final itemBox = _itemKeys[itemId]?.currentContext?.findRenderObject()
        as RenderBox?;
    final slotBox = _slotKeys[item.acceptedSlotId]
        ?.currentContext
        ?.findRenderObject() as RenderBox?;
    if (itemBox == null || slotBox == null) return;

    final start = itemBox.localToGlobal(Offset.zero);
    final end = slotBox.localToGlobal(Offset.zero);
    final size = itemBox.size;

    setState(() {
      _inFlight[itemId] = _InFlight(
        itemId: itemId,
        assetPath: item.assetPath,
        start: start,
        end: end,
        size: size,
      );
    });
  }

  SceneItem? _itemForSlot(SceneState state, String slotId) {
    for (final it in state.variant.items) {
      if (state.placedItemIds.contains(it.id) &&
          it.acceptedSlotId == slotId) {
        return it;
      }
    }
    return null;
  }
}

/// v2 — table/scene area. Renders the scene's backgroundAsset PNG
/// behind the slots; falls back to a warm rounded "table" container
/// when the asset is missing. Slots are positioned via their
/// [SceneSlot.relativeRect] (0..1 unit space) scaled to the actual
/// area dimensions.
class _SceneArea extends StatelessWidget {
  const _SceneArea({
    required this.state,
    required this.slotKeys,
    required this.itemForSlot,
  });

  final SceneState state;
  final Map<String, GlobalKey> slotKeys;
  final SceneItem? Function(SceneState, String) itemForSlot;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        return Stack(
          children: [
            // Background — scene-specific PNG with a stylised fallback.
            Positioned.fill(
              child: Container(
                decoration: BoxDecoration(
                  color: const Color(0xFFE9D9B7), // warm wood-table beige
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withValues(alpha: 0.08),
                      blurRadius: 12,
                      offset: const Offset(0, 3),
                    ),
                  ],
                ),
                clipBehavior: Clip.antiAlias,
                child: Image.asset(
                  state.scene.backgroundAsset,
                  fit: BoxFit.cover,
                  errorBuilder: (_, __, ___) => const SizedBox.expand(),
                ),
              ),
            ),
            // Slots positioned via relativeRect.
            for (final slot in state.scene.slots)
              Positioned(
                left: slot.relativeRect.left * c.maxWidth,
                top: slot.relativeRect.top * c.maxHeight,
                width: slot.relativeRect.width * c.maxWidth,
                height: slot.relativeRect.height * c.maxHeight,
                child: KeyedSubtree(
                  key: slotKeys.putIfAbsent(slot.id, GlobalKey.new),
                  child: _BuildSlot(
                    slot: slot,
                    state: state,
                    itemForSlot: itemForSlot,
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _BuildSlot extends StatelessWidget {
  const _BuildSlot({
    required this.slot,
    required this.state,
    required this.itemForSlot,
  });

  final SceneSlot slot;
  final SceneState state;
  final SceneItem? Function(SceneState, String) itemForSlot;

  @override
  Widget build(BuildContext context) {
    final filledItem = itemForSlot(state, slot.id);
    return SceneSlotWidget(
      slot: slot,
      filled: filledItem != null,
      filledAssetPath: filledItem?.assetPath,
      filledLabel: filledItem?.labelTr,
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 16,
            color: AppColors.textSecondary,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}

class _InFlight {
  _InFlight({
    required this.itemId,
    required this.assetPath,
    required this.start,
    required this.end,
    required this.size,
  });

  final String itemId;
  final String assetPath;
  final Offset start;
  final Offset end;
  final Size size;
}
