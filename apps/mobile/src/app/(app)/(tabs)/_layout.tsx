import { Tabs } from 'expo-router/js-tabs';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { useUnread } from '@/hooks/queries';
import { Colors, FontWeight, Layout, Radius } from '@/theme';

const ICONS: Record<string, string> = {
  index: '🔥',
  friends: '🫂',
  inbox: '📬',
  profile: '🍆',
};

const LABELS: Record<string, string> = {
  index: 'Çelınclar',
  friends: 'Kankalar',
  inbox: 'Gelen',
  profile: 'Ben',
};

export default function TabsLayout() {
  const unread = useUnread();
  const unreadCount = unread.data?.count ?? 0;
  /**
   * The bar has to clear whatever the phone puts below it — the iPhone home
   * indicator, an Android gesture pill — or the system draws over the labels
   * and "Çelınclar" loses its bottom half. A hardcoded per-platform padding
   * cannot know that; the inset does.
   */
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 10);

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textFaint,
        tabBarStyle: [
          styles.bar,
          { height: Layout.tabBarHeight + bottomInset, paddingBottom: bottomInset },
        ],
        tabBarItemStyle: styles.item,
        tabBarLabelStyle: styles.label,
        tabBarLabel: LABELS[route.name] ?? route.name,
        tabBarIcon: ({ focused }) => (
          <View style={styles.iconWrap}>
            <Text style={[styles.icon, !focused && styles.iconDim]}>{ICONS[route.name] ?? '•'}</Text>
            {route.name === 'inbox' && unreadCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText} numberOfLines={1}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              </View>
            ) : null}
          </View>
        ),
      })}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="friends" />
      <Tabs.Screen name="inbox" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: Colors.surface,
    borderTopColor: Colors.border,
    borderTopWidth: 1,
    paddingTop: 8,
  },
  item: { paddingVertical: 2 },
  label: { fontSize: 10, lineHeight: 14, fontWeight: FontWeight.bold, letterSpacing: 0.2, marginTop: 2 },
  iconWrap: { width: 30, height: 22, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 18, lineHeight: 22 },
  iconDim: { opacity: 0.45 },
  badge: {
    position: 'absolute',
    top: -4,
    right: -6,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: Radius.pill,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: Colors.white, fontSize: 9, fontWeight: FontWeight.black },
});
