/// Build-time configuration read from `--dart-define`.
///
/// Each patient/therapist pair ships its own binary with:
///
/// ```
/// flutter build apk \
///   --dart-define=SUPABASE_URL=https://xxx.supabase.co \
///   --dart-define=SUPABASE_ANON_KEY=<anon-key> \
///   --dart-define=THERAPIST_EMAIL=therapist@clinic.tr
/// ```
///
/// No UI surface exposes these; by design the patient and caregiver
/// never see the therapist email or can change the backend target.
class BuildConfig {
  const BuildConfig._();

  static const String supabaseUrl =
      String.fromEnvironment('SUPABASE_URL');

  static const String supabaseAnonKey =
      String.fromEnvironment('SUPABASE_ANON_KEY');

  static const String therapistEmail =
      String.fromEnvironment('THERAPIST_EMAIL');

  /// Whether cloud sync + weekly report can be attempted. If any of
  /// the three required defines are missing, we silently run in
  /// local-only mode — useful for local development without a
  /// Supabase project.
  static bool get cloudEnabled =>
      supabaseUrl.isNotEmpty &&
      supabaseAnonKey.isNotEmpty &&
      therapistEmail.isNotEmpty;
}
