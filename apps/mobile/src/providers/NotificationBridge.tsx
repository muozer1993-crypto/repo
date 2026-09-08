import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { useToast } from '@/components/Toast';
import { qk } from '@/lib/query';
import { StorageKeys, getItem, setItem } from '@/lib/storage';
import { registerBackgroundSync, setBackgroundHandler } from '@/services/background';
import {
  addReceivedListener,
  addResponseListener,
  fireLocal,
  getInitialRoute,
  installNotificationHandler,
  registerForPush,
  setBadgeCount,
  type NotificationRoute,
} from '@/services/notifications';
import { flushQueue } from '@/services/offlineQueue';
import { syncReminders, type ReminderChallenge } from '@/services/reminders';
import { getDailySteps, startForegroundStepTracking } from '@/services/steps';
import { useAuth, useLevel } from '@/store/auth';

/**
 * Glue between the OS and the app:
 *  - registers the push token with the server once we are logged in
 *  - routes notification taps
 *  - polls the inbox and raises a local notification when push is unavailable
 *    (Expo Go on Android, denied permission, no project id)
 *  - pushes step totals to the server in the foreground and in the background
 */
export function NotificationBridge() {
  const token = useAuth((s) => s.token);
  const serverUrl = useAuth((s) => s.serverUrl);
  const makeClient = useAuth((s) => s.client);
  const toast = useToast();
  const level = useLevel();
  const queryClient = useQueryClient();
  const pushTokenSent = useRef<string | null>(null);

  // --- push registration -------------------------------------------------
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    installNotificationHandler();
    (async () => {
      const registration = await registerForPush();
      if (cancelled || !registration.token) return;
      if (pushTokenSent.current === registration.token) return;
      try {
        await makeClient().setPushToken({
          token: registration.token,
          platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        });
        pushTokenSent.current = registration.token;
        await setItem(StorageKeys.pushToken, registration.token);
      } catch {
        // the inbox poll below keeps the app usable without push
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, serverUrl, makeClient]);

  // --- notification taps -------------------------------------------------
  useEffect(() => {
    if (!token) return;
    const go = (route: NotificationRoute) => {
      if (!route) return;
      if (route.kind === 'inbox') router.push('/(app)/(tabs)/inbox');
      else if (route.kind === 'friends') router.push('/(app)/(tabs)/friends');
      else if (route.kind === 'results') router.push(`/challenge/${route.challengeId}/results`);
      else router.push(`/challenge/${route.challengeId}`);
    };

    void getInitialRoute().then(go);
    const response = addResponseListener(go);
    const received = addReceivedListener((title, body, data) => {
      void queryClient.invalidateQueries({ queryKey: qk.unread });
      void queryClient.invalidateQueries({ queryKey: qk.inbox });
      const payload = (data ?? {}) as { type?: string; challengeId?: string };
      toast({
        title: title || 'KOYDUM',
        body,
        kind: payload.type === 'taunt' ? 'taunt' : 'info',
        onPress: () =>
          go(
            payload.challengeId
              ? payload.type === 'taunt'
                ? { kind: 'results', challengeId: payload.challengeId }
                : { kind: 'challenge', challengeId: payload.challengeId }
              : { kind: 'inbox' }
          ),
      });
    });
    return () => {
      response.remove();
      received.remove();
    };
  }, [token, queryClient, toast]);

  // --- inbox poll: local notification when push did not deliver ----------
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const client = makeClient();
        const unread = await client.unreadCount();
        if (cancelled) return;
        await setBadgeCount(unread.count);
        const lastSeen = await getItem(StorageKeys.lastInboxId);
        if (!unread.latestId || unread.latestId === lastSeen) return;

        const items = await client.inbox({ limit: 10 });
        if (cancelled) return;
        await setItem(StorageKeys.lastInboxId, unread.latestId);
        // only surface items the server could not push itself
        const fresh = items.filter((item) => !item.readAt && item.pushed !== true);
        if (lastSeen === null) return; // first run: do not replay history
        for (const item of fresh.slice(0, 3)) {
          if (AppState.currentState === 'active') {
            toast({
              title: item.title,
              body: item.body,
              kind: item.type === 'taunt' ? 'taunt' : 'info',
              onPress: () => router.push('/(app)/(tabs)/inbox'),
            });
          } else {
            await fireLocal(item.title, item.body, { ...item.data, type: item.type });
          }
        }
      } catch {
        // offline: try again on the next tick
      }
    };

    void poll();
    const id = setInterval(poll, 45_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void poll();
    });
    return () => {
      cancelled = true;
      clearInterval(id);
      sub.remove();
    };
  }, [token, serverUrl, makeClient, toast]);

  // --- steps: foreground counter + background sync ----------------------
  useEffect(() => {
    if (!token) return;
    const stopTracking = startForegroundStepTracking();

    const syncSteps = async () => {
      try {
        const days = await getDailySteps(7);
        if (days.length === 0) return;
        await makeClient().syncSteps(days);
        void queryClient.invalidateQueries({ queryKey: ['challenges'] });
      } catch {
        // ignore: the user can always sync by hand from the home screen
      }
    };

    // anything logged while offline goes out as soon as we can reach the server
    const drain = async () => {
      try {
        await flushQueue(makeClient());
      } catch {
        // the queue keeps the entries; we try again on the next foreground
      }
    };

    // local reminders: a check-in deadline and the final hour of each challenge
    const scheduleReminders = async () => {
      try {
        const summaries = await makeClient().challenges('active,pending');
        const todayKeyLocal = new Date().toLocaleDateString('en-CA');
        const reminders: ReminderChallenge[] = summaries.map((summary) => ({
          id: summary.challenge.id,
          title: summary.challenge.title,
          endsAt: summary.challenge.endsAt,
          metricType: summary.challenge.metricType,
          deadlineTime: summary.challenge.deadlineTime,
          doneToday: (summary.me?.lastEntryAt ?? '').slice(0, 10) === todayKeyLocal,
        }));
        await syncReminders(reminders, level);
      } catch {
        // reminders are a nicety; never block on them
      }
    };

    void syncSteps();
    void drain();
    void scheduleReminders();
    setBackgroundHandler(async () => {
      await syncSteps();
      await drain();
      try {
        const unread = await makeClient().unreadCount();
        await setBadgeCount(unread.count);
      } catch {
        // ignore
      }
    });
    void registerBackgroundSync();

    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void syncSteps();
      void drain();
      void scheduleReminders();
    });

    return () => {
      stopTracking();
      setBackgroundHandler(null);
      sub.remove();
    };
  }, [token, serverUrl, makeClient, queryClient, level]);

  return null;
}
