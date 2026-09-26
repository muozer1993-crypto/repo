/**
 * Config plugin for the local KoydumScreenTime module.
 *
 * Declares PACKAGE_USAGE_STATS in the Android manifest. Android will not grant
 * it at runtime — the user flips a switch under Settings → Apps → Special app
 * access → Usage access — but the manifest entry is what makes KOYDUM appear in
 * that list at all. Lint flags the permission as "protected" (it is meant for
 * system apps) so the entry carries `tools:ignore`; the release build's
 * lintVital step is what failed once already over a manifest detail.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const PERMISSION = 'android.permission.PACKAGE_USAGE_STATS';
const TOOLS_NS = 'http://schemas.android.com/tools';

function withScreenTimePermission(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.$ = manifest.$ || {};
    if (!manifest.$['xmlns:tools']) manifest.$['xmlns:tools'] = TOOLS_NS;

    // Expo's own helper writes plain <uses-permission>; we need the tools attribute too,
    // so drop any duplicate first and add the annotated one.
    manifest['uses-permission'] = (manifest['uses-permission'] || []).filter(
      (item) => item.$['android:name'] !== PERMISSION
    );
    manifest['uses-permission'].push({
      $: { 'android:name': PERMISSION, 'tools:ignore': 'ProtectedPermissions' },
    });
    return mod;
  });
}

module.exports = withScreenTimePermission;
