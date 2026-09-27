import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Text } from '@/components/Text';
import { useApi } from '@/hooks/useApi';
import { StorageKeys, getJson, setJson } from '@/lib/storage';
import { Colors, Spacing } from '@/theme';
import { compareVersions } from '@/utils/url';

/**
 * "Yeni sürüm var" — for the Android APK the server says it hosts.
 *
 * JavaScript fixes reach installed phones over the air, but a build that
 * changes native code (a new permission, a new module) needs a new APK, and an
 * old install cannot find that out on its own: it just quietly misses the
 * feature. The server's /health says which version it offers; this compares it
 * with the installed one and offers the download. Closing it hides it until
 * the next version.
 */
export function useAppUpdate(): { latest: string; downloadUrl: string; notes: string | null } | null {
  const api = useApi();
  const installed = Application.nativeApplicationVersion;
  const { data } = useQuery({
    queryKey: ['health', 'app'],
    queryFn: () => api.health(),
    enabled: Platform.OS === 'android' && !!installed,
    staleTime: 6 * 60 * 60 * 1000,
    retry: false,
  });
  const offered = data?.app;
  if (!installed || !offered?.latestVersion || !offered.downloadUrl) return null;
  if (compareVersions(offered.latestVersion, installed) <= 0) return null;
  return { latest: offered.latestVersion, downloadUrl: offered.downloadUrl, notes: offered.notes ?? null };
}

export function UpdateBanner() {
  const update = useAppUpdate();
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void getJson<string>(StorageKeys.dismissedUpdate).then((value) => {
      if (alive) setDismissed(typeof value === 'string' ? value : null);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!update || dismissed === undefined || dismissed === update.latest) return null;

  const close = () => {
    setDismissed(update.latest);
    void setJson(StorageKeys.dismissedUpdate, update.latest);
  };

  return (
    <Card edgeColor={Colors.yellow} style={styles.card}>
      <Text variant="body" bold>
        Yeni sürüm var: {update.latest}
      </Text>
      <Text variant="tiny" muted style={styles.body}>
        {update.notes ? `${update.notes} ` : ''}İndirip eskisinin üstüne kur, hesabın ve çelınclar yerinde kalır.
      </Text>
      <View style={styles.row}>
        <Button title="İndir" size="sm" style={styles.grow} onPress={() => void Linking.openURL(update.downloadUrl)} />
        <Button title="Sonra" variant="ghost" size="sm" onPress={close} />
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
