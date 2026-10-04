import type { PublicUser } from '@koydum/shared';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { Colors, Radius, Spacing } from '@/theme';

export interface FriendRowProps {
  user: PublicUser;
  selected: boolean;
  onToggle: (id: string) => void;
}

/**
 * One friend in a multi-pick: the wizard's "KANKALAR" step and the çelınc
 * screen's "Kanka ekle" sheet pick people the same way.
 */
export function FriendRow({ user, selected, onToggle }: FriendRowProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={() => onToggle(user.id)}
      style={({ pressed }) => [styles.row, selected && styles.rowOn, pressed && styles.pressed]}>
      <Avatar emoji={user.avatarEmoji} name={user.displayName} size={40} ring={selected ? Colors.accent : null} />
      <View style={styles.grow}>
        <Text variant="body" bold numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text variant="tiny" faint numberOfLines={1}>
          @{user.username}
        </Text>
      </View>
      <View style={[styles.check, selected && styles.checkOn]}>
        <Text variant="tiny" bold color={selected ? Colors.white : Colors.textFaint}>
          {selected ? '✓' : ''}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  rowOn: { borderColor: Colors.accent, backgroundColor: Colors.surfaceHigh },
  pressed: { opacity: 0.75 },
  grow: { flex: 1 },
  check: {
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
});
