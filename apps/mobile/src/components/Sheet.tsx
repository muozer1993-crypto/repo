import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { ToastView, useToastLayer } from '@/components/Toast';
import { Colors, Layout, Radius, Spacing } from '@/theme';
import { keyboardBehavior } from '@/utils/keyboard';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** let the content scroll (long lists of taunts) */
  scroll?: boolean;
}

/** Bottom sheet built on the RN Modal so it works on web too. */
export function Sheet({ visible, onClose, title, children, scroll = true }: SheetProps) {
  const insets = useSafeAreaInsets();
  const onTop = useToastLayer(visible);
  const body = (
    <View style={styles.body}>
      {title ? (
        <Text variant="title" style={styles.title}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
      onRequestClose={onClose}
      statusBarTranslucent>
      {/* The Modal's window is edge-to-edge on Android, so the keyboard covers
          it instead of shrinking it. This lifts the sheet clear of the keyboard;
          its maxHeight is then a share of what the keyboard leaves, so a tall
          sheet scrolls rather than running off the top. */}
      <KeyboardAvoidingView style={styles.root} behavior={keyboardBehavior()}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
          <View style={styles.grabber} />
          {scroll ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {body}
            </ScrollView>
          ) : (
            body
          )}
        </View>
      </KeyboardAvoidingView>
      {/* A toast raised while the sheet is open (an error from its own form,
          most of the time) is drawn here, over the scrim: the root tree's copy
          would sit under this Modal's window. Outside the KeyboardAvoidingView,
          so the keyboard does not move it. */}
      {onTop ? <ToastView /> : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: Colors.scrim },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: Colors.border,
    maxHeight: '88%',
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
  },
  grabber: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingBottom: Spacing.lg },
  body: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
  title: { marginBottom: Spacing.xs },
});
