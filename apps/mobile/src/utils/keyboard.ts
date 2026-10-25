import { Platform } from 'react-native';

/**
 * How a KeyboardAvoidingView makes room for the keyboard.
 *
 * Android builds are edge-to-edge on every version (`edgeToEdgeEnabled=true`
 * in the prebuilt gradle.properties, which RN's Modal follows too), and an
 * edge-to-edge window is never shrunk for the keyboard: `adjustResize` no
 * longer does anything. So Android needs the same 'padding' as iOS, or every
 * field near the bottom, and every Sheet, sits under the keyboard. The web
 * keeps a plain View: the browser moves the page itself.
 *
 * A function rather than a constant so a test can switch Platform.OS.
 */
export function keyboardBehavior(): 'padding' | undefined {
  return Platform.OS === 'web' ? undefined : 'padding';
}
