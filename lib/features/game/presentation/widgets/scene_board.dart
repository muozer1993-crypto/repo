import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/audio/audio_service.dart';
import '../../../../core/haptics/haptics_service.dart';
import '../../application/scene_controller.dart';
import '../../domain/scene.dart';
import 'flying_item_overlay.dart';
import 'scene_item_tile.dart';
import 'scene_slot.dart';

/// Renders the scene's background, the slot layer, the tray, and
/// manages the mid-flight animations for correct taps.
class SceneBoard extends ConsumerStatefulWidget {
  const SceneBoard({super.key});

  @override
  ConsumerState<SceneBoard> createState() => _SceneBoardState();
}

class _SceneBoardState extends ConsumerState<SceneBoard> {
  /// Keys for each tray tile so we can grab their global rect when a
  /// fly-to animation kicks off.
  final Map<String, GlobalKey> _itemKeys = {};

  /// Keys for each slot so we can target fly-to animations.
  final Map<String, GlobalKey> _slotKeys = {};

  final Map<String, GlobalKey<SceneItemTileState>> _tileStateKeys = {};

  /// In-flight fly-to animations. Keyed by itemId.
  final Map<String, _InFlight> _inFlight = {};

  @override
  Widget build(BuildContext context) {
    // React to new outcomes from the controller.
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
    return LayoutBuilder(
      builder: (context, constraints) {
        return Stack(
          children: [
            _background(state.scene),
            ..._buildSlots(state),
            _buildTray(state, constraints),
            ..._inFlightOverlays(),
          ],
        );
      },
    );
  }

  Widget _background(Scene scene) {
    return Positioned.fill(
      child: Image.asset(
        scene.backgroundAsset,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => const ColoredBox(color: Color(0xFFEFE4CF)),
      ),
    );
  }

  List<Widget> _buildSlots(SceneState state) {
    return state.scene.slots.map((slot) {
      _slotKeys.putIfAbsent(slot.id, GlobalKey.new);
      final filledItem = _itemForSlot(state, slot.id);
      return LayoutBuilder(
        builder: (context, c) {
          final rect = slot.relativeRect;
          final totalW = MediaQuery.of(context).size.width;
          final totalH = MediaQuery.of(context).size.height;
          return Positioned(
            left: rect.left * totalW,
            top: rect.top * totalH,
            width: rect.width * totalW,
            height: rect.height * totalH,
            child: KeyedSubtree(
              key: _slotKeys[slot.id],
              child: SceneSlotWidget(
                slot: slot,
                filled: filledItem != null,
                filledAssetPath: filledItem?.assetPath,
              ),
            ),
          );
        },
      );
    }).toList(growable: false);
  }

  Widget _buildTray(SceneState state, BoxConstraints cons) {
    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      height: 160,
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.85),
          border: const Border(
            top: BorderSide(width: 1, color: Color(0x22000000)),
          ),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Center(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: state.variant.items.map((item) {
                _itemKeys.putIfAbsent(item.id, GlobalKey.new);
                _tileStateKeys.putIfAbsent(
                  item.id,
                  GlobalKey<SceneItemTileState>.new,
                );
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: SizedBox(
                    width: 120,
                    height: 136,
                    child: KeyedSubtree(
                      key: _itemKeys[item.id],
                      child: SceneItemTile(
                        key: _tileStateKeys[item.id],
                        item: item,
                        placed: state.placedItemIds.contains(item.id),
                        hinted: state.hintTargetItemId == item.id,
                        onTap: () => _onTap(item),
                      ),
                    ),
                  ),
                );
              }).toList(growable: false),
            ),
          ),
        ),
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
      // Play SFX + haptic; fly-to animation kicks off via ref.listen.
      ref.read(audioServiceProvider).playCorrectSoft();
      ref.read(hapticsServiceProvider).light();
    }
    // Wobble for incorrect outcomes is triggered in ref.listen as well.
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
    if (!state.placedItemIds
        .any((id) => _itemAcceptedBy(state, id) == slotId)) {
      return null;
    }
    for (final it in state.variant.items) {
      if (state.placedItemIds.contains(it.id) &&
          it.acceptedSlotId == slotId) {
        return it;
      }
    }
    return null;
  }

  String? _itemAcceptedBy(SceneState state, String itemId) {
    for (final it in state.variant.items) {
      if (it.id == itemId) return it.acceptedSlotId;
    }
    return null;
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
