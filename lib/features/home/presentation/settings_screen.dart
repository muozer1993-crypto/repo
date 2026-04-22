import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/motion.dart';
import '../../../l10n/strings_tr.dart';
import '../../../shared/widgets/reduced_motion_switch.dart';
import '../../profile/data/profile_repository.dart';

/// Caregiver-facing settings. Reachable from a small icon on the home
/// screen. No patient-facing affordances.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Keep the profile's reducedMotion in sync with the provider on open.
    ref.listen(patientProfileProvider, (_, next) {
      final p = next.value;
      if (p == null) return;
      ref.read(reducedMotionProvider.notifier).state = p.reducedMotion;
    });

    return Scaffold(
      appBar: AppBar(title: const Text(StringsTr.settingsTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: const [
            ReducedMotionSwitch(),
          ],
        ),
      ),
    );
  }
}
