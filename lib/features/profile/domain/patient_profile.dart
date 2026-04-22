import 'package:isar/isar.dart';

part 'patient_profile.g.dart';

/// Coarse age band — the only demographic we capture.
///
/// Kept as a band (not a birthdate) so that clinical reports aggregate
/// cleanly and the cloud data carries less re-identifiable information.
enum AgeBand { under65, from65to74, from75to84, over85 }

/// Single-profile patient record (v1).
///
/// Anything that can leak re-identification is deliberately kept out:
/// no surname, no birthdate, no contact info. Just the first name (so
/// the greeting can say "Günaydın Ayşe") + age band.
///
/// [profileId] is a UUID we generate on first launch and share with
/// Supabase's anon auth. All server rows key off this id so that
/// multiple devices never collide.
@collection
class PatientProfile {
  Id id = Isar.autoIncrement;

  /// First name only.
  late String name;

  @enumerated
  late AgeBand ageBand;

  late DateTime createdAt;

  /// Caregiver-settable accessibility preference. Defaults to false; the
  /// animations are already subdued so most users won't toggle this.
  bool reducedMotion = false;

  /// UUID generated on first launch. Matches `auth.uid()` on Supabase
  /// after the anonymous sign-in, and is used as the `profile_id`
  /// foreign key on every server row.
  @Index(unique: true)
  late String profileId;

  /// Null until the first successful upsert to Supabase `profiles`.
  DateTime? syncedAt;
}
