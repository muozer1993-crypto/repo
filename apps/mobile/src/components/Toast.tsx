import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Text';
import { Colors, Layout, Radius, Shadow, Spacing } from '@/theme';
import { USE_NATIVE_DRIVER, useAnimatedValue } from '@/utils/animation';

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

/** What a ToastView needs to draw the current toast, wherever it is mounted. */
interface ToastStateValue {
  toast: ToastState | null;
  opacity: Animated.Value;
  hide: () => void;
  /** the real status-bar inset, read above the offline strip's override (OfflineFrame) */
  topInset: number;
}

const ToastStateContext = createContext<ToastStateValue | null>(null);

/**
 * The open Sheets, in the order they opened. A Sheet is an RN Modal: its own
 * window on Android and iOS and a body portal on the web, so a toast drawn in
 * the root tree sits under its scrim, dimmed and out of reach of a tap. The
 * Sheet opened last draws the toast instead, and the provider only while none
 * is open.
 */
interface ToastLayers {
  push: (id: string) => void;
  pop: (id: string) => void;
  top: string | null;
}

const ToastLayerContext = createContext<ToastLayers>({ push: () => {}, pop: () => {}, top: null });

/** Registers an open layer; true while it is the one that should draw the toast. */
export function useToastLayer(visible: boolean): boolean {
  const { push, pop, top } = useContext(ToastLayerContext);
  const id = useId();
  useEffect(() => {
    if (!visible) return;
    push(id);
    return () => pop(id);
  }, [visible, id, push, pop]);
  return visible && top === id;
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
  const opacity = useAnimatedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const nextId = useRef(0);
  // which way the running fade goes, so it can be picked up again (below)
  const fading = useRef<'in' | 'out'>('in');
  const [layers, setLayers] = useState<string[]>([]);
  // Made once: each open Sheet's effect depends on these, and a new pair per
  // render would pop and re-push every open Sheet, reshuffling which is on top.
  const [{ push, pop }] = useState(() => ({
    push: (id: string) => setLayers((open) => [...open.filter((other) => other !== id), id]),
    pop: (id: string) => setLayers((open) => open.filter((other) => other !== id)),
  }));

  const hide = useCallback(() => {
    fading.current = 'out';
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
      fading.current = 'in';
      opacity.setValue(0);
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: USE_NATIVE_DRIVER }).start();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, options.durationMs ?? 4200);
    },
    [hide, opacity]
  );

  const value = useMemo(() => show, [show]);

  // A toast raised just before the provider goes away (a screen test tearing
  // down) must not fire its hide into an unmounted tree.
  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, []);

  const top = layers[layers.length - 1] ?? null;
  const showing = toast !== null;

  // The toast changes views when a Sheet opens or closes over it, and Animated
  // stops a running fade once the last view on its value goes away: a fade-in
  // froze where it was (often still invisible), a fade-out never cleared the
  // toast. Whichever view draws it now finishes the fade.
  useEffect(() => {
    if (!showing) return;
    if (fading.current === 'out') hide();
    else Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: USE_NATIVE_DRIVER }).start();
  }, [top, showing, hide, opacity]);

  return (
    <ToastContext.Provider value={value}>
      <ToastStateContext.Provider value={{ toast, opacity, hide, topInset: insets.top }}>
        <ToastLayerContext.Provider value={{ push, pop, top }}>
          {children}
          {layers.length === 0 ? <ToastView /> : null}
        </ToastLayerContext.Provider>
      </ToastStateContext.Provider>
    </ToastContext.Provider>
  );
}

/**
 * The toast itself. ToastProvider draws it over the app while no Sheet is
 * open; the topmost open Sheet draws it inside its Modal (useToastLayer).
 */
export function ToastView() {
  const state = useContext(ToastStateContext);
  if (!state?.toast) return null;
  const { toast, opacity, hide, topInset } = state;
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { top: topInset + Spacing.sm, opacity }]}>
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
