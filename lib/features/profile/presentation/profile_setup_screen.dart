import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
import '../../../l10n/strings_tr.dart';
import '../../../shared/widgets/big_button.dart';
import '../data/profile_repository.dart';
import '../domain/patient_profile.dart';

/// First-run profile setup. Caregiver-facing (not patient-facing):
/// collects a first name and age band, then routes to home.
///
/// Deliberately minimal — no avatar, no birthdate, no contact info.
/// Any more data would get in the way and add re-identification risk.
class ProfileSetupScreen extends ConsumerStatefulWidget {
  const ProfileSetupScreen({super.key});

  @override
  ConsumerState<ProfileSetupScreen> createState() =>
      _ProfileSetupScreenState();
}

class _ProfileSetupScreenState extends ConsumerState<ProfileSetupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  AgeBand _selected = AgeBand.from65to74;
  bool _saving = false;

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _onSave() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    try {
      await ref.read(profileRepositoryProvider).create(
            name: _nameController.text,
            ageBand: _selected,
          );
      // go_router will react to the new profile and redirect to /home.
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 48, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      StringsTr.profileSetupTitle,
                      style: t.displayLarge,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 40),
                    Text(StringsTr.profileNameLabel, style: t.bodyLarge),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _nameController,
                      style: const TextStyle(fontSize: 24),
                      textCapitalization: TextCapitalization.words,
                      decoration: InputDecoration(
                        hintText: StringsTr.profileNameHint,
                        hintStyle:
                            const TextStyle(color: AppColors.textMuted),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 20,
                          vertical: 20,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(16),
                          borderSide: const BorderSide(
                            color: AppColors.slotOutline,
                          ),
                        ),
                      ),
                      validator: (v) => (v == null || v.trim().isEmpty)
                          ? StringsTr.profileNameRequired
                          : null,
                    ),
                    const SizedBox(height: 32),
                    Text(StringsTr.profileAgeLabel, style: t.bodyLarge),
                    const SizedBox(height: 12),
                    _AgeBandSelector(
                      value: _selected,
                      onChanged: (v) => setState(() => _selected = v),
                    ),
                    const SizedBox(height: 40),
                    BigButton(
                      label: StringsTr.profileSaveButton,
                      onPressed: _saving ? null : _onSave,
                      expand: true,
                      icon: Icons.check_rounded,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AgeBandSelector extends StatelessWidget {
  const _AgeBandSelector({required this.value, required this.onChanged});

  final AgeBand value;
  final ValueChanged<AgeBand> onChanged;

  static const _entries = <(AgeBand, String)>[
    (AgeBand.under65, StringsTr.profileAgeUnder65),
    (AgeBand.from65to74, StringsTr.profileAge65to74),
    (AgeBand.from75to84, StringsTr.profileAge75to84),
    (AgeBand.over85, StringsTr.profileAgeOver85),
  ];

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: _entries.map((entry) {
        final selected = entry.$1 == value;
        return ChoiceChip(
          selected: selected,
          onSelected: (_) => onChanged(entry.$1),
          label: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Text(
              entry.$2,
              style: const TextStyle(fontSize: 22),
            ),
          ),
          selectedColor: AppColors.primary.withValues(alpha: 0.18),
          backgroundColor: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
            side: BorderSide(
              color:
                  selected ? AppColors.primary : AppColors.slotOutline,
              width: selected ? 2 : 1,
            ),
          ),
        );
      }).toList(),
    );
  }
}
