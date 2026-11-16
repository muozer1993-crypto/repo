/**
 * Config plugin for the local KoydumScreenTime module.
 *
 * Declares PACKAGE_USAGE_STATS in the Android manifest. Android will not grant
 * it at runtime — the user flips a switch under Settings → Apps → Special app
 * access → Usage access — but the manifest entry is what makes KOYDUM appear in
 * that list at all. Lint flags the permission as "protected" (it is meant for
 * system apps) so the entry carries `tools:ignore`; the release build's
 * lintVital step is what failed once already over a manifest detail.
 *
 * It also asks to see the phone's home screens (addHomeQuery below), which the
 * module leaves out of screen time.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const PERMISSION = 'android.permission.PACKAGE_USAGE_STATS';
const TOOLS_NS = 'http://schemas.android.com/tools';
const HOME_ACTION = 'android.intent.action.MAIN';
const HOME_CATEGORY = 'android.intent.category.HOME';

function hasName(items, name) {
  return (items || []).some((item) => item.$ && item.$['android:name'] === name);
}

/**
 * Adds `<queries><intent>MAIN + HOME</intent></queries>`. Since Android 11 an
 * app only sees the packages its manifest asks about, and without this entry the
 * module's launcher lookup found nothing but Settings' FallbackHome: the real
 * home screen, its app drawer and Pixel's Recents all counted as screen time.
 * This one intent is all it needs, so no QUERY_ALL_PACKAGES. Idempotent, and it
 * keeps whatever queries the manifest already has (the template's https VIEW).
 */
function addHomeQuery(manifest) {
  if (!Array.isArray(manifest.queries) || manifest.queries.length === 0) manifest.queries = [{}];
  const present = manifest.queries.some((query) =>
    (query.intent || []).some(
      (intent) => hasName(intent.action, HOME_ACTION) && hasName(intent.category, HOME_CATEGORY)
    )
  );
  if (!present) {
    const query = manifest.queries[0];
    query.intent = query.intent || [];
    query.intent.push({
      action: [{ $: { 'android:name': HOME_ACTION } }],
      category: [{ $: { 'android:name': HOME_CATEGORY } }],
    });
  }
  return manifest;
}

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
    addHomeQuery(manifest);
    return mod;
  });
}

module.exports = withScreenTimePermission;
module.exports.addHomeQuery = addHomeQuery;
