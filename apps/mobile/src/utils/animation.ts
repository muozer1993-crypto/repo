import { Platform } from 'react-native';

/**
 * `useNativeDriver` on web logs "Animated: `useNativeDriver` is not supported
 * because the native animated module is missing" and silently falls back to the
 * JS driver, so every `Animated` call in the app passes this instead of `true`.
 */
export const USE_NATIVE_DRIVER = Platform.OS !== 'web';
