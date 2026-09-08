import { Alert, Platform } from 'react-native';

/**
 * A yes/no confirmation that works on both targets.
 *
 * `Alert.alert` is a no-op in react-native-web, so the browser gets
 * `window.confirm` instead — and the static web export renders with no `window`
 * at all, where the safe answer is "no".
 */
export function confirmTr(title: string, message: string, confirmLabel: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
      return Promise.resolve(false);
    }
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Vazgeç', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}
