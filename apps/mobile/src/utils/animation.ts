import { useState } from 'react';
import { Animated, Platform } from 'react-native';

/**
 * `useNativeDriver` on web logs "Animated: `useNativeDriver` is not supported
 * because the native animated module is missing" and silently falls back to the
 * JS driver, so every `Animated` call in the app passes this instead of `true`.
 */
export const USE_NATIVE_DRIVER = Platform.OS !== 'web';

/**
 * A stable `Animated.Value` that satisfies the React Compiler.
 *
 * The usual `useRef(new Animated.Value(0)).current` reads a ref during render,
 * which the compiler rejects (and which would break if it ever re-ordered the
 * read). `useState` with a lazy initialiser gives the same "created once" value
 * without touching a ref.
 */
export function useAnimatedValue(initial = 0): Animated.Value {
  const [value] = useState(() => new Animated.Value(initial));
  return value;
}
