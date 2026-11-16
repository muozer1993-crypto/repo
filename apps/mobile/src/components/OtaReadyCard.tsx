import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { useLevel } from '@/store/auth';
import { Colors, Spacing } from '@/theme';
import { byLevel } from '@/utils/levelCopy';

/**
 * A check is a request to the update server; a friend flicking between apps
 * needs one per half hour at most.
 */
const CHECK_EVERY_MS = 30 * 60 * 1000;

/**
 * When the last check started. Module-level, so it holds for the whole JS run:
 * a home screen mounted again after a logout does not check again, and nothing
 * reads it while drawing.
 */
let lastCheckAt: number | null = null;

/**
 * Looks for an update and downloads it when there is one; the download is what
 * brings the card up. Every failure is swallowed: offline, or the update server
 * did not answer. A failed check does not count, so the next time the app
 * comes back to the front tries again.
 */
async function lookForUpdate(): Promise<void> {
  const now = Date.now();
  if (lastCheckAt !== null && now - lastCheckAt < CHECK_EVERY_MS) return;
  const previous = lastCheckAt;
  lastCheckAt = now;
  try {
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) await Updates.fetchUpdateAsync();
  } catch {
    lastCheckAt = previous;
  }
}

/**
 * "Güncelleme hazır" — an over-the-air fix that is on the phone but not running.
 *
 * expo-updates looks for an update only when the app starts cold, and the
 * start that finds one downloads it in the background and keeps running the
 * old JavaScript (app.json: fallbackToCacheTimeout 0). A friend who only ever
 * comes back from recents or a notification kept the old code for days, and
 * the one whose phone did download it ran the old code for that whole process
 * life. So the home screen looks again every time the app comes back to the
 * front (at most once per half hour), and once a download is in, offers to
 * restart into it.
 *
 * It never restarts by itself: a resume from a notification would lose the
 * screen it opened, and a focus session or a half-picked photo its state.
 * "Sonra" hides it until the home screen mounts again (a new login); the next
 * cold start runs the new code anyway.
 */
export function OtaReadyCard() {
  // the web stub reports isEnabled too, and a debug build rejects every call
  if (Platform.OS === 'web' || __DEV__ || !Updates.isEnabled) return null;
  return <ReadyCard />;
}

function ReadyCard() {
  const level = useLevel();
  const { isUpdatePending } = Updates.useUpdates();
  const [later, setLater] = useState(false);

  // the cold start checked on its own; this covers every return to the front
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void lookForUpdate();
    });
    return () => sub.remove();
  }, []);

  if (!isUpdatePending || later) return null;

  // a refused reload leaves the download where it is, for the next cold start
  const reload = () => {
    Updates.reloadAsync().catch(() => {});
  };

  return (
    <Card edgeColor={Colors.yellow} style={styles.card}>
      <Text variant="body" bold>
        {byLevel(level, 'Güncelleme hazır', 'Güncelleme hazır, bir yenile', 'Eski sürümle gezme, yenile 🍆')}
      </Text>
      <Text variant="tiny" muted style={styles.body}>
        Yeni düzeltmeler telefona indi. “Yenile”ye basınca uygulama bir an kapanıp yeni hâliyle açılır; sonra
        dersen, uygulamayı tamamen kapatıp açtığında kendiliğinden güncellenir.
      </Text>
      <View style={styles.row}>
        <Button title="Yenile" size="sm" style={styles.grow} onPress={reload} />
        <Button title="Sonra" variant="ghost" size="sm" onPress={() => setLater(true)} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: Spacing.md },
  body: { marginTop: 2 },
  row: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  grow: { flex: 1 },
});
