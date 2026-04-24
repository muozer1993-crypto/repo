import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/isar_db.dart';
import '../../../core/time/clock_provider.dart';
import '../../../core/time/time_window.dart';
import '../../profile/data/profile_repository.dart';
import '../../progress/domain/bonus_play_event.dart';
import '../data/scene_repository.dart';
import '../domain/scene.dart';
import 'widgets/bonus/find_item_widget.dart';
import 'widgets/bonus/free_explore_widget.dart';
import 'widgets/bonus/pair_match_widget.dart';
import 'widgets/bonus/tap_sequence_widget.dart';
import 'widgets/bonus/bonus_common.dart';

/// Args needed to launch the bonus player. Set via
/// [bonusPlayerArgsProvider] before navigating.
class BonusPlayerArgs {
  const BonusPlayerArgs({
    required this.bonusSceneId,
    required this.nightBonus,
  });

  final String bonusSceneId;
  final bool nightBonus;
}

final bonusPlayerArgsProvider = StateProvider<BonusPlayerArgs?>((_) => null);

/// Mount point for bonus widgets. Loads the BonusScene by id, dispatches
/// to the right widget based on [BonusScene.bonusType], and persists a
/// [BonusPlayEvent] when the widget finishes.
class BonusPlayerScreen extends ConsumerStatefulWidget {
  const BonusPlayerScreen({super.key});

  @override
  ConsumerState<BonusPlayerScreen> createState() => _BonusPlayerScreenState();
}

class _BonusPlayerScreenState extends ConsumerState<BonusPlayerScreen> {
  BonusScene? _scene;
  DateTime? _startedAt;
  final _bonusPlayId = DateTime.now().microsecondsSinceEpoch.toString();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final args = ref.read(bonusPlayerArgsProvider);
    if (args == null) return;
    final repo = ref.read(sceneRepositoryProvider);
    final scene = await repo.bonusById(args.bonusSceneId);
    if (!mounted) return;
    setState(() {
      _scene = scene;
      _startedAt = ref.read(clockProvider)();
    });
  }

  Future<void> _onFinished(BonusPlayResult result) async {
    final profile = ref.read(patientProfileProvider).value;
    final args = ref.read(bonusPlayerArgsProvider);
    if (profile == null || args == null || _startedAt == null) {
      _popHome();
      return;
    }
    final now = ref.read(clockProvider)();
    final tw = windowFor(now);
    final ev = BonusPlayEvent()
      ..bonusPlayId = _bonusPlayId
      ..profileId = profile.profileId
      ..bonusSceneId = result.bonusSceneId
      ..bonusType = bonusTypeId(result.bonusType)
      ..startedAt = _startedAt!
      ..finishedAt = result.finishedAt
      ..tapCount = result.tapCount
      ..nightBonus = args.nightBonus
      ..timeWindow = timeWindowId(tw);

    final isar = ref.read(isarProvider);
    // ignore: avoid_dynamic_calls
    await isar.writeTxn(() async {
      // ignore: avoid_dynamic_calls
      await isar.bonusPlayEvents.put(ev);
    });
    _popHome();
  }

  void _popHome() {
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final scene = _scene;
    if (scene == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    switch (scene.bonusType) {
      case BonusType.findItem:
        return FindItemWidget(bonusScene: scene, onFinished: _onFinished);
      case BonusType.tapSequence:
        return TapSequenceWidget(bonusScene: scene, onFinished: _onFinished);
      case BonusType.pairMatch:
        return PairMatchWidget(bonusScene: scene, onFinished: _onFinished);
      case BonusType.freeExplore:
        return FreeExploreWidget(bonusScene: scene, onFinished: _onFinished);
    }
  }
}
