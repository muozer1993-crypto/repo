import fs from 'fs';
import path from 'path';

import { compareVersions } from '@/utils/url';

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

/**
 * 1.1.1 is a new APK whose changes are all native (the screen-time module
 * below), so it stays on 1.1.0's update stream: `eas update` keeps reaching the
 * 1.1.0 phones that have not installed it yet. Back on `policy: appVersion`,
 * every 1.1.0 phone would stop getting fixes the day 1.1.1 is built. The pin
 * moves only when the JS starts calling native code an older APK lacks
 * (README 1b), and it can never be ahead of the APK's own version.
 */
describe('the update runtime in app.json', () => {
  const expo: { version: string; runtimeVersion: unknown } = require('../../app.json').expo;

  it('is pinned to 1.1.0 so 1.1.0 and 1.1.1 take the same eas update', () => {
    expect(expo.runtimeVersion).toBe('1.1.0');
  });

  it('is not ahead of the version the APK reports', () => {
    expect(compareVersions(expo.version, expo.runtimeVersion as string)).toBeGreaterThanOrEqual(0);
  });

  it('matches the app version in package.json', () => {
    expect(require('../../package.json').version).toBe(expo.version);
  });
});

/**
 * Screen time leaves the home screen out, as Digital Wellbeing does. Finding
 * the home screen needs a MAIN/HOME <queries> entry under Android 11's package
 * visibility; without it the lookup only saw Settings' FallbackHome and the
 * launcher, its app drawer and Pixel's Recents all counted.
 */
describe('the screen-time module', () => {
  type Named = { $: Record<string, string> }[];
  type Intent = { action?: Named; category?: Named; data?: Named };
  type Manifest = { queries?: { intent?: Intent[] }[] };

  const { addHomeQuery } = require('../../modules/koydum-screen-time/app.plugin.js') as {
    addHomeQuery: (manifest: Manifest) => Manifest;
  };
  const browsable = (): Intent => ({
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    category: [{ $: { 'android:name': 'android.intent.category.BROWSABLE' } }],
    data: [{ $: { 'android:scheme': 'https' } }],
  });
  const isHome = (intent: Intent) =>
    intent.action?.[0]?.$['android:name'] === 'android.intent.action.MAIN' &&
    intent.category?.[0]?.$['android:name'] === 'android.intent.category.HOME';

  it('asks to see the home screen once, next to the queries already there', () => {
    const manifest: Manifest = { queries: [{ intent: [browsable()] }] };
    addHomeQuery(manifest);
    addHomeQuery(manifest);
    const intents = manifest.queries?.flatMap((query) => query.intent ?? []) ?? [];
    expect(intents).toContainEqual(browsable());
    expect(intents.filter(isHome)).toHaveLength(1);
  });

  it('adds the queries block when the manifest has none', () => {
    const manifest: Manifest = {};
    addHomeQuery(manifest);
    expect(manifest.queries?.[0]?.intent?.filter(isHome)).toHaveLength(1);
  });

  // No Gradle here to compile the Kotlin; these keep the two fixes from quietly going back.
  const kotlin = fs.readFileSync(
    path.join(
      __dirname,
      '../../modules/koydum-screen-time/android/src/main/java/expo/modules/koydumscreentime/KoydumScreenTimeModule.kt'
    ),
    'utf8'
  );

  it('closes the foreground on SCREEN_NON_INTERACTIVE (16), not KEYGUARD_SHOWN (17)', () => {
    expect(kotlin).toMatch(/EVENT_SCREEN_OFF = 16\b/);
  });

  it('falls back to every home screen when no default one is picked', () => {
    expect(kotlin).toContain('queryIntentActivities(home');
  });
});
