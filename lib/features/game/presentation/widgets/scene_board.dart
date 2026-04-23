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

/// Grid-based scene layout.
///
/// The JSON-positioned scene board required a photographic background
/// for the slot coordinates to make sense. While illustration assets
/// are still being produced we render slots and tray tiles as two
/// equal-width rows — a visual model that reads as
/// "match the bottom items to the top boxes" without needing any
/// image assets.
///
/// When background + item images land later the grid stays; the
/// slot/tile contents switch from text-fallback to imagery.
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
            // Top 96 leaves room for the labeled Çık/Dinle buttons and
            // the instruction banner sitting between them (both owned
            // by ScenePlayerScreen's stack).
            padding: const EdgeInsets.fromLTRB(12, 96, 12, 12),
            child: LayoutBuilder(
              builder: (context, cons) {
                return Column(
                  children: [
                    _SectionHeader(
                      text: 'Eşyaları doğru yerlere koy',
                      color: AppColors.primary,
                    ),
                    const SizedBox(height: 6),
                    Expanded(
                      flex: 5,
                      child: _slotRow(state),
                    ),
                    const SizedBox(height: 10),
                    _SectionHeader(
                      text: 'Eşyalar — dokunduğun yukarı uçar',
                      color: AppColors.textSecondary,
                    ),
                    const SizedBox(height: 6),
                    Expanded(
                      flex: 5,
                      child: _trayRow(state),
                    ),
                  ],
                );
              },
            ),
          ),
        ),
        ..._inFlightOverlays(),
      ],
    );
  }

  Widget _slotRow(SceneState state) {
    return LayoutBuilder(
      builder: (context, cons) {
        return Row(
          children: state.scene.slots.map((slot) {
            _slotKeys.putIfAbsent(slot.id, GlobalKey.new);
            final filledItem = _itemForSlot(state, slot.id);
            return Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: KeyedSubtree(
                  key: _slotKeys[slot.id],
                  child: SceneSlotWidget(
                    slot: slot,
                    filled: filledItem != null,
                    filledAssetPath: filledItem?.assetPath,
                    filledLabel: filledItem?.labelTr,
                  ),
                ),
              ),
            );
          }).toList(growable: false),
        );
      },
    );
  }

  Widget _trayRow(SceneState state) {
    final items = state.variant.items;
    // ≤5 items fit in a single equal-width row. More items split
    // into two rows so nothing shrinks below a legible tile width.
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

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 16,
            color: color,
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
