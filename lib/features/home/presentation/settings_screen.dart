import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
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
          children: [
            const ReducedMotionSwitch(),
            const Divider(height: 48),
            _ResetProfileTile(),
          ],
        ),
      ),
    );
  }
}

class _ResetProfileTile extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListTile(
      leading: const Icon(
        Icons.restart_alt_rounded,
        size: 28,
        color: AppColors.textSecondary,
      ),
      title: const Text(
        'Profili sıfırla',
        style: TextStyle(fontSize: 24, color: AppColors.textPrimary),
      ),
      subtitle: const Text(
        'Kayıtlı isim ve yaş bilgisini siler, uygulamayı baştan '
        'kurmuş gibi açar. Oturum ve ilerleme verisi silinmez.',
        style: TextStyle(fontSize: 16, color: AppColors.textSecondary),
      ),
      contentPadding:
          const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
      onTap: () => _confirm(context, ref),
    );
  }

  Future<void> _confirm(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Profili sıfırla?'),
        content: const Text(
          'Kayıtlı isim ve yaş bandı silinecek. Uygulama yeniden '
          'profil oluşturma ekranıyla açılacak.',
          style: TextStyle(fontSize: 18),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Vazgeç', style: TextStyle(fontSize: 18)),
          ),
          ElevatedButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Evet, sıfırla'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    await ref.read(profileRepositoryProvider).clear();
    // The router watches patientProfileProvider and redirects to
    // /setup automatically when the row disappears.
  }
}
