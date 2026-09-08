import { Tabs } from 'expo-router/js-tabs';
import { Platform, StyleSheet, View } from 'react-native';

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
  index: 'Çelinçler',
  friends: 'Kankalar',
  inbox: 'Gelen',
  profile: 'Ben',
};

export default function TabsLayout() {
  const unread = useUnread();
  const unreadCount = unread.data?.count ?? 0;

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textFaint,
        tabBarStyle: styles.bar,
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
    height: Layout.tabBarHeight + (Platform.OS === 'ios' ? 22 : 0),
    paddingTop: 6,
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
  },
  item: { paddingVertical: 2 },
  label: { fontSize: 10, fontWeight: FontWeight.bold, letterSpacing: 0.2 },
  iconWrap: { width: 30, alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 20 },
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
