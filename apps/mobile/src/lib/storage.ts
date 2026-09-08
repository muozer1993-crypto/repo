import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Small key/value layer. The auth token goes into the keychain on device;
 * everything else (and everything on web) uses AsyncStorage.
 */

const SECURE_KEYS = new Set(['koydum.token']);

function canUseSecureStore(key: string): boolean {
  return Platform.OS !== 'web' && SECURE_KEYS.has(key);
}

export async function getItem(key: string): Promise<string | null> {
  try {
    if (canUseSecureStore(key)) {
      const value = await SecureStore.getItemAsync(key.replace(/\./g, '_'));
      if (value !== null) return value;
      // fall through: value may predate the secure-store migration
    }
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    if (canUseSecureStore(key)) {
      await SecureStore.setItemAsync(key.replace(/\./g, '_'), value);
      // keep a copy out of AsyncStorage so the token only lives in the keychain
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, value);
  } catch {
    // storage is best-effort: a failure here must never crash the app
  }
}

export async function removeItem(key: string): Promise<void> {
  try {
    if (canUseSecureStore(key)) {
      await SecureStore.deleteItemAsync(key.replace(/\./g, '_'));
    }
    await AsyncStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await setItem(key, JSON.stringify(value));
}

export const StorageKeys = {
  token: 'koydum.token',
  me: 'koydum.me',
  serverUrl: 'koydum.serverUrl',
  onboarded: 'koydum.onboarded',
  pushToken: 'koydum.pushToken',
  stepCache: 'koydum.stepCache',
  focusSession: 'koydum.focusSession',
  lastInboxId: 'koydum.lastInboxId',
} as const;
