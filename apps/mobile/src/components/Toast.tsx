import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { Colors, Layout, Radius, Shadow, Spacing } from '@/theme';
import { USE_NATIVE_DRIVER } from '@/utils/animation';

export type ToastKind = 'info' | 'success' | 'danger' | 'taunt';

export interface ToastOptions {
  title: string;
  body?: string;
  kind?: ToastKind;
  durationMs?: number;
  onPress?: () => void;
}

interface ToastState extends ToastOptions {
  id: number;
}

const ToastContext = createContext<(options: ToastOptions) => void>(() => {});

export function useToast(): (options: ToastOptions) => void {
  return useContext(ToastContext);
}

const KIND_COLOR: Record<ToastKind, string> = {
  info: Colors.info,
  success: Colors.success,
  danger: Colors.danger,
  taunt: Colors.accent,
};

/** In-app banner used for events that arrive while the app is open. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const nextId = useRef(0);

  const hide = useCallback(() => {
    Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: USE_NATIVE_DRIVER }).start(
      ({ finished }) => {
        // `show` interrupts this fade with `opacity.setValue(0)`, which fires
        // this callback with finished=false; clearing then would wipe the toast
        // that was just raised
        if (finished) setToast(null);
      }
    );
  }, [opacity]);

  const show = useCallback(
    (options: ToastOptions) => {
      nextId.current += 1;
      setToast({ ...options, id: nextId.current });
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: USE_NATIVE_DRIVER }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, options.durationMs ?? 4200);
    },
    [hide, opacity]
  );

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.wrap, { top: insets.top + Spacing.sm, opacity }]}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              toast.onPress?.();
              hide();
            }}
            style={[styles.toast, { borderColor: KIND_COLOR[toast.kind ?? 'info'] }]}>
            <View style={[styles.stripe, { backgroundColor: KIND_COLOR[toast.kind ?? 'info'] }]} />
            <View style={styles.body}>
              <Text variant="small" bold numberOfLines={1}>
                {toast.title}
              </Text>
              {toast.body ? (
                <Text variant="tiny" muted numberOfLines={2}>
                  {toast.body}
                </Text>
              ) : null}
            </View>
          </Pressable>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: Spacing.lg, zIndex: 100 },
  toast: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: Colors.surfaceHigh,
    borderRadius: Radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    width: '100%',
    maxWidth: Layout.maxWidth,
    ...Shadow.card,
  },
  stripe: { width: 4 },
  body: { flex: 1, paddingVertical: Spacing.md, paddingHorizontal: Spacing.md, gap: 2 },
});
