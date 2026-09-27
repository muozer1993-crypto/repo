/**
 * Friends download the APK over mobile data from the owner's home upload (the
 * tunnel, `/koydum.apk`), and every byte of it slows everyone's API calls
 * while it runs. Two expo-build-properties settings keep it at roughly half
 * its old size: ARM-only ABIs (no friend's phone is x86; those libraries were
 * ~49 MB of emulator code) and compressed native libraries. Both are one line
 * in app.json that a later edit could quietly drop, and nothing else would
 * notice until the next download took ten minutes again.
 */

type BuildProperties = { android?: { buildArchs?: string[]; useLegacyPackaging?: boolean } };
type PluginEntry = string | [string, BuildProperties];

function androidBuildProperties() {
  const plugins: PluginEntry[] = require('../../app.json').expo.plugins;
  const entry = plugins.find(
    (plugin): plugin is [string, BuildProperties] =>
      Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
  );
  return entry?.[1].android;
}

describe('the Android build settings in app.json', () => {
  it('builds only the ARM ABIs real phones run', () => {
    const archs = androidBuildProperties()?.buildArchs;
    expect(archs).toBeDefined();
    expect(archs).toEqual(expect.arrayContaining(['arm64-v8a', 'armeabi-v7a']));
    expect(archs).not.toContain('x86');
    expect(archs).not.toContain('x86_64');
  });

  it('compresses the native libraries inside the APK', () => {
    expect(androidBuildProperties()?.useLegacyPackaging).toBe(true);
  });
});

/**
 * Ayarlar → Arka plan (modules/koydum-device) opens two system pages that do
 * nothing for an app whose manifest lacks the permission: the battery dialog
 * refuses to open, and the exact-alarm switch never lists KOYDUM. USE_EXACT_ALARM
 * is the other way to get exact alarms, but it is meant for alarm-clock and
 * calendar apps and Play turns everyone else away.
 */
describe('the Android permissions in app.json', () => {
  const permissions: string[] = require('../../app.json').expo.android.permissions;

  it('asks for the battery exemption and exact alarms', () => {
    expect(permissions).toEqual(
      expect.arrayContaining([
        'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        'android.permission.SCHEDULE_EXACT_ALARM',
      ])
    );
  });

  it('does not ask for the alarm-clock-only USE_EXACT_ALARM', () => {
    expect(permissions).not.toContain('android.permission.USE_EXACT_ALARM');
  });
});
