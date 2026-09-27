import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { useToast } from '@/components/Toast';
import { qk } from '@/lib/query';
import { StorageKeys, setItem } from '@/lib/storage';
import { registerBackgroundSync, setBackgroundHandler } from '@/services/background';
import {
  addReceivedListener,
  addResponseListener,
  getInitialRoute,
  installNotificationHandler,
  registerForPush,
  routeForNotificationData,
  type NotificationRoute,
} from '@/services/notifications';
import { clearFailed, flushQueue, readQueue } from '@/services/offlineQueue';
import { syncReminders, type ReminderChallenge } from '@/services/reminders';
import { startForegroundStepTracking } from '@/services/steps';
import { syncStepsNow } from '@/services/stepSync';
import { syncScreenTimeNow } from '@/services/screenTimeSync';
import { invalidateForNotifications } from '@/hooks/queries';
import { useTimezone } from '@/hooks/useTimezone';
import { useAuth, useLevel } from '@/store/auth';
import { safeDayKey, safeTodayKey } from '@/utils/datetime';
import { applyPendingInvite } from '@/services/invite';
import { deliverNewInbox } from '@/services/inboxNotifier';

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
  // A renewed token (services/session) or a password change swaps the token
  // string but not the person; the tap handler keys on this so it does not
  // replay the notification the app was opened with.
  const signedIn = !!token;
  const serverUrl = useAuth((s) => s.serverUrl);
  const makeClient = useAuth((s) => s.client);
  const refreshMe = useAuth((s) => s.refreshMe);
  const toast = useToast();
  const level = useLevel();
  const tz = useTimezone();
  const queryClient = useQueryClient();
  const pushTokenSent = useRef<string | null>(null);

  // --- push registration -------------------------------------------------
  useEffect(() => {
    if (!token) {
      // the next account has to register the same device token again
      pushTokenSent.current = null;
      return;
    }
    let cancelled = false;
    let busy = false;
    installNotificationHandler();
    // A phone that booted without signal (or reached the server a second too
    // late) used to stay without push for the whole session: the POST ran once.
    // It now runs again every time the app comes to the foreground until the
    // server has the token; once it does, it never repeats.
    const register = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        const registration = await registerForPush();
        if (cancelled || !registration.token) return;
        if (pushTokenSent.current === registration.token) return;
        await makeClient().setPushToken({
          token: registration.token,
          platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        });
        pushTokenSent.current = registration.token;
        await setItem(StorageKeys.pushToken, registration.token);
      } catch {
        // the inbox poll below keeps the app usable without push; next foreground retries
      } finally {
        busy = false;
      }
    };
    void register();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && pushTokenSent.current === null) void register();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [token, serverUrl, makeClient]);

  // --- an invite link opened before this account existed -----------------
  useEffect(() => {
    if (!token) return;
    let alive = true;
    void (async () => {
      const outcome = await applyPendingInvite(makeClient(), serverUrl);
      if (!alive || !outcome) return;
      if (outcome.kind === 'sent' || outcome.kind === 'accepted') {
        void queryClient.invalidateQueries({ queryKey: qk.friends });
        toast({
          title: outcome.kind === 'accepted' ? 'Kanka oldunuz' : 'Kanka isteği gitti',
          body:
            outcome.kind === 'accepted'
              ? 'İlk çelıncı aç, kim kime koyacak görelim.'
              : `${outcome.name ?? 'Davet eden'} kabul edince çelınc açabilirsiniz.`,
          kind: 'success',
        });
      } else if (outcome.kind === 'missing') {
        toast({ title: 'Davet kodu geçersizmiş', body: 'Arkadaşını kullanıcı adıyla ekleyebilirsin.', kind: 'info' });
      } else if (outcome.kind === 'failed') {
        toast({ title: 'Kanka isteği gitmedi', body: outcome.message, kind: 'danger' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, serverUrl, makeClient, queryClient, toast]);

  // --- notification taps -------------------------------------------------
  useEffect(() => {
    if (!signedIn) return;
    const go = (route: NotificationRoute) => {
      if (!route) return;
      if (route.notificationId) {
        // opening it is reading it, as a tap on the row in Gelen is; without
        // this the badge kept counting a laf the loser had already opened
        makeClient()
          .markInboxRead({ ids: [route.notificationId] })
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: qk.unread });
            void queryClient.invalidateQueries({ queryKey: qk.inbox });
          })
          .catch(() => {});
      }
      if (route.kind === 'inbox') router.push('/(app)/(tabs)/inbox');
      else if (route.kind === 'friends') router.push('/(app)/(tabs)/friends');
      else if (route.kind === 'results') router.push(`/challenge/${route.challengeId}/results`);
      else router.push(`/challenge/${route.challengeId}`);
    };

    void getInitialRoute().then(go);
    const response = addResponseListener(go);
    const received = addReceivedListener((title, body, data) => {
      const payload = (data ?? {}) as { type?: string };
      invalidateForNotifications(queryClient, [{ type: payload.type, data }]);
      // the toast opens what a tap on the push would: a finished çelınc and the
      // winner's "hâlâ bekliyor" go to the results, not the çelınc screen
      const route = routeForNotificationData(data) ?? { kind: 'inbox' };
      toast({
        title: title || 'KOYDUM',
        body,
        kind: payload.type === 'taunt' ? 'taunt' : 'info',
        onPress: () => go(route),
      });
    });
    return () => {
      response.remove();
      received.remove();
    };
  }, [signedIn, makeClient, queryClient, toast]);

  // --- inbox poll: local notification when push did not deliver ----------
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    const poll = async () => {
      try {
        // decided after the fetch: the user may leave the app while it runs
        const delivery = await deliverNewInbox(makeClient(), () =>
          AppState.currentState === 'active' ? 'in-app' : 'system'
        );
        if (cancelled) return;
        // Without push this poll is the only one that hears of a new row, on
        // screen or not; the lists it touches refetch now, not on the next pull.
        if (delivery.items.length > 0) invalidateForNotifications(queryClient, delivery.items);
        const [newest] = delivery.items;
        if (delivery.surface !== 'in-app' || !newest) return;
        // one toast at a time: a second one would only replace the first
        const more = delivery.items.length - 1;
        toast({
          title: newest.title,
          body: more > 0 ? `${newest.body}\nGelen kutunda ${more} bildirim daha var.` : newest.body,
          kind: newest.type === 'taunt' ? 'taunt' : 'info',
          onPress: () => router.push('/(app)/(tabs)/inbox'),
        });
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
  }, [token, serverUrl, makeClient, queryClient, toast]);

  // --- steps: foreground counter + background sync ----------------------
  useEffect(() => {
    if (!token) return;
    const stopTracking = startForegroundStepTracking();

    const syncSteps = async () => {
      try {
        await syncStepsNow({ client: makeClient(), queryClient, refreshMe });
      } catch {
        // ignore: the user can always sync by hand from the home screen
      }
      // Android reads its own screen time; everywhere else this returns at once
      try {
        await syncScreenTimeNow({ client: makeClient(), queryClient, refreshMe });
      } catch {
        // same: the çelınc screen has a button for it
      }
    };

    // anything logged while offline goes out as soon as we can reach the server
    const drain = async () => {
      try {
        const result = await flushQueue(makeClient());
        if (result.sent > 0) {
          void queryClient.invalidateQueries({ queryKey: ['challenges'] });
          void queryClient.invalidateQueries({ queryKey: ['challenge'] });
        }
        // Read the queue, not this pass's counter: an entry can be refused by a
        // flush this code did not start (the one after a successful write, or the
        // headless background task), and the user still has to hear about it.
        const failed = (await readQueue()).filter((item) => item.failedReason);
        if (failed.length > 0) {
          // the server refused these for good; say so once, then stop holding them
          const reason = failed[0]?.failedReason ?? 'Sunucu kabul etmedi.';
          await clearFailed();
          toast({
            title:
              failed.length > 1
                ? `${failed.length} giriş gönderilemedi`
                : 'Bir giriş gönderilemedi',
            body: reason,
            kind: 'danger',
          });
        }
      } catch {
        // the queue keeps the entries; we try again on the next foreground
      }
    };

    // local reminders: a check-in deadline and the final hour of each challenge
    const scheduleReminders = async () => {
      try {
        const summaries = await makeClient().challenges('active,pending');
        // day keys are counted in the ACCOUNT's zone, both here and on the server
        const todayKeyLocal = safeTodayKey(tz);
        const reminders: ReminderChallenge[] = summaries.map((summary) => ({
          id: summary.challenge.id,
          title: summary.challenge.title,
          endsAt: summary.challenge.endsAt,
          metricType: summary.challenge.metricType,
          deadlineTime: summary.challenge.deadlineTime,
          doneToday: safeDayKey(summary.me?.lastEntryAt, tz) === todayKeyLocal,
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
        // the app is alive but not on screen: new items become phone notifications
        const delivery = await deliverNewInbox(makeClient(), 'system');
        // and the poll will not see them again when the app comes back
        if (delivery.items.length > 0) invalidateForNotifications(queryClient, delivery.items);
      } catch {
        // offline: the next run tries again
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
  }, [token, serverUrl, makeClient, queryClient, level, tz, refreshMe, toast]);

  return null;
}
