import { addDays } from '@koydum/shared';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { useToast } from '@/components/Toast';
import { qk } from '@/lib/query';
import { StorageKeys, removeItem, setItem } from '@/lib/storage';
import { registerBackgroundSync, setBackgroundHandler } from '@/services/background';
import {
  addReceivedListener,
  addResponseListener,
  getInitialRoute,
  installNotificationHandler,
  pushTokenNeedsSending,
  registerForPush,
  routeForNotificationData,
  type NotificationRoute,
} from '@/services/notifications';
import { clearFailed, currentOwnerId, flushQueue, readQueue } from '@/services/offlineQueue';
import { flushPendingPushClear } from '@/services/pushClear';
import { refreshReminders } from '@/services/reminders';
import { startForegroundStepTracking } from '@/services/steps';
import { syncStepsNow } from '@/services/stepSync';
import { syncScreenTimeNow } from '@/services/screenTimeSync';
import {
  cachedChallengeTimezone,
  cachedChallengeTitle,
  invalidateForNotifications,
  invalidateFriendships,
} from '@/hooks/queries';
import { useTimezone } from '@/hooks/useTimezone';
import { useAuth, useLevel } from '@/store/auth';
import { applyPendingInvite } from '@/services/invite';
import { deliverNewInbox } from '@/services/inboxNotifier';
import { resolveTimezone, safeTodayKey } from '@/utils/datetime';
import { formatDayKeyFriendly } from '@/utils/format';
import { byLevel } from '@/utils/levelCopy';
import { goToTab } from '@/utils/navigation';

/**
 * Glue between the OS and the app:
 *  - registers the push token with the server once we are logged in
 *  - routes notification taps
 *  - polls the inbox and raises a local notification when push is unavailable
 *    (Expo Go on Android, denied permission, no project id)
 *  - pushes step totals to the server in the foreground and in the background
 *
 * The two parts that can raise a system dialog (push registration asks for
 * notifications, the foreground step counter for physical activity) wait while
 * the welcome slides are up: the last slide asks for both, with a reason.
 */

/**
 * Rows that change which çelınclar the phone's own reminders cover: a kanka's
 * yes can be the second one (a `pending` çelınc with one yes gets none), a
 * start or a cancel moves them too. Ali's phone last refreshed while he sat
 * alone in his "Yarın 04:00" Erken Kalkan Koyar, and nothing but the
 * background task would have set its first 06:30 alarm.
 */
const REPLANS_REMINDERS = new Set(['challenge_accepted', 'challenge_started', 'challenge_cancelled']);

/** How often an open app looks for a parked entry that never got an answer (below). */
const PARKED_RETRY_MS = 15_000;

/**
 * The screen a notification opens: the same for a push tap, its toast and the
 * poll's toast. `navigate`, not `push`: a "Dürtüldün" toast about the çelınc
 * on screen (or a second tap on the banner) stacked another copy of it, and
 * back seemed to do nothing. It still opens another çelınc over this one.
 */
function openRoute(route: Exclude<NotificationRoute, null>): void {
  if (route.kind === 'inbox') goToTab('/(app)/(tabs)/inbox');
  else if (route.kind === 'friends') goToTab('/(app)/(tabs)/friends');
  else if (route.kind === 'results') router.navigate(`/challenge/${route.challengeId}/results`);
  else if (route.invite) router.navigate({ pathname: '/challenge/[id]', params: { id: route.challengeId, invite: route.invite } });
  else router.navigate(`/challenge/${route.challengeId}`);
}

export function NotificationBridge() {
  const token = useAuth((s) => s.token);
  // A renewed token (services/session) or a password change swaps the token
  // string but not the person; the tap handler keys on this so it does not
  // run again for it. A real sign-in does run it again, and getInitialRoute
  // hands out a tap only once, so the old one is not replayed then either.
  const signedIn = !!token;
  const serverUrl = useAuth((s) => s.serverUrl);
  const makeClient = useAuth((s) => s.client);
  const refreshMe = useAuth((s) => s.refreshMe);
  const onboarding = useAuth((s) => s.onboarding);
  const toast = useToast();
  const level = useLevel();
  const tz = useTimezone();
  const queryClient = useQueryClient();
  /** `${session token}|${device push token}` the server last accepted */
  const pushTokenSent = useRef<string | null>(null);
  /** The reminder refresh with the current level and zone, once the bridge runs one (below). */
  const replanReminders = useRef<(() => Promise<void>) | null>(null);

  // --- push registration -------------------------------------------------
  useEffect(() => {
    if (!token) {
      // the next account has to register the same device token again
      pushTokenSent.current = null;
      return;
    }
    if (onboarding) return;
    let cancelled = false;
    let busy = false;
    // Keyed on the session too: a password change hands this phone a new token
    // and clears the push token on the server (the phones it signed out might
    // hold it), so the same device token has to go up again.
    const session = `${token}|`;
    installNotificationHandler();
    // A phone that booted without signal (or reached the server a second too
    // late) used to stay without push for the whole session: the POST ran once.
    // It now runs again every time the app comes to the foreground until the
    // server has the token; once it does, only when the server lost it (below).
    const register = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        // asks only if nothing has this run: after a no on the welcome slide,
        // home's card points to the settings page instead of the same dialog
        const registration = await registerForPush({ askAgain: false });
        if (cancelled) return;
        // Home's battery card has to know this phone lives on the background
        // check ('no-fcm'); it reads it from here, since asking again is what
        // brings up the permission prompt.
        if (registration.reason) void setItem(StorageKeys.pushReason, registration.reason);
        else void removeItem(StorageKeys.pushReason);
        if (!registration.token) return;
        const sent = session + registration.token;
        if (pushTokenSent.current === sent) return;
        // A cold start of a phone that already sent this token for this account
        // leaves the slot alone while the server holds one: after a move it is
        // the new phone's (`pushTokenNeedsSending`). /me is read fresh for it.
        const fresh = await refreshMe();
        if (cancelled) return;
        if (!(await pushTokenNeedsSending(registration.token, fresh?.hasPushToken))) {
          pushTokenSent.current = sent;
          return;
        }
        await makeClient().setPushToken({
          token: registration.token,
          platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        });
        pushTokenSent.current = sent;
        await setItem(StorageKeys.pushToken, registration.token);
      } catch {
        // the inbox poll below keeps the app usable without push; next foreground retries
      } finally {
        busy = false;
      }
    };
    void register();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (!pushTokenSent.current?.startsWith(session)) {
        void register();
        return;
      }
      // The server can still lose it: the account has one slot, and a logout
      // from an app older than the token it sends (store/auth) clears whatever
      // is there. This phone then had neither push nor a notification of its
      // own (a stored token means push delivers) until it was restarted. /me
      // says whether the server holds a token, not whose, so a second phone of
      // the account holding it is left alone.
      void refreshMe().then((fresh) => {
        if (cancelled || fresh?.hasPushToken !== false) return;
        pushTokenSent.current = null;
        void register();
      });
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [token, serverUrl, makeClient, refreshMe, onboarding]);

  // --- a logout's "stop pushing here" the server did not hear ------------
  // Signed out, nothing else here runs on a foreground; the start and the
  // background task send it too (services/pushClear).
  useEffect(() => {
    if (token) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void flushPendingPushClear();
    });
    return () => sub.remove();
  }, [token]);

  // --- an invite link opened before this account existed -----------------
  useEffect(() => {
    if (!token) return;
    let alive = true;
    void (async () => {
      const outcome = await applyPendingInvite(makeClient(), serverUrl);
      if (!alive || !outcome) return;
      if (outcome.kind === 'sent' || outcome.kind === 'accepted') {
        invalidateFriendships(queryClient);
        // the level as it is now, not as a dependency: /me can bring it after
        // the token, and a rerun here would drop the toast of the first one
        const readerLevel = useAuth.getState().me?.vulgarityMax ?? 2;
        toast({
          title: outcome.kind === 'accepted' ? 'Kanka oldunuz' : 'Kanka isteği gitti',
          body:
            outcome.kind === 'accepted'
              ? byLevel(
                  readerLevel,
                  'İlk çelıncı aç, bakalım kim kazanacak.',
                  'İlk çelıncı aç, kim kime koyacak görelim.',
                  'İlk çelıncı aç, kim kime koyacak görelim.'
                )
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
      // Over the welcome slides a tap stacked the app on them: the slides
      // stayed mounted, their cleanup never ended onboarding, and push, steps
      // and reminders stayed off until a restart. The row waits in Gelen.
      if (!route || useAuth.getState().onboarding) return;
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
      openRoute(route);
    };

    void getInitialRoute().then(go);
    const response = addResponseListener(go);
    const received = addReceivedListener((title, body, data) => {
      const payload = (data ?? {}) as { type?: string };
      invalidateForNotifications(queryClient, [{ type: payload.type, data }]);
      if (payload.type && REPLANS_REMINDERS.has(payload.type)) void replanReminders.current?.();
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
        if (delivery.items.some((item) => REPLANS_REMINDERS.has(item.type))) void replanReminders.current?.();
        const [newest] = delivery.items;
        if (delivery.surface !== 'in-app' || !newest) return;
        // one toast at a time: a second one would only replace the first
        const more = delivery.items.length - 1;
        // A single new row opens its own screen and counts as read, as a tap on
        // its push would; several of them are a pile for Gelen.
        const route =
          more === 0
            ? routeForNotificationData({ ...newest.data, type: newest.type, notificationId: newest.id })
            : null;
        toast({
          title: newest.title,
          body: more > 0 ? `${newest.body}\nGelen kutunda ${more} bildirim daha var.` : newest.body,
          kind: newest.type === 'taunt' ? 'taunt' : 'info',
          onPress: () => {
            // the poll runs over the welcome slides too: see `go` above
            if (useAuth.getState().onboarding) return;
            if (!route) {
              goToTab('/(app)/(tabs)/inbox');
              return;
            }
            makeClient()
              .markInboxRead({ ids: [newest.id] })
              .then(() => {
                void queryClient.invalidateQueries({ queryKey: qk.unread });
                void queryClient.invalidateQueries({ queryKey: qk.inbox });
              })
              .catch(() => {});
            openRoute(route);
          },
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
    if (!token || onboarding) return;
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
          // A parked check-in keeps today's poke until it lands; the refresh
          // that ran beside this drain may have read the list before it did.
          void scheduleReminders();
        }
        // The background handler runs this too while the app is alive but off
        // screen: a toast there reaches nobody, and clearing after it lost the
        // entries without a word. They wait; coming back to the front drains
        // again and tells then.
        if (AppState.currentState !== 'active') return;
        // Read the queue, not this pass's counter: an entry can be refused by a
        // flush this code did not start (the one after a successful write, or the
        // headless background task), and the user still has to hear about it.
        // Only this account's: another account's refusal waits, failed, for its
        // owner. Told to whoever had the phone next, it showed them somebody
        // else's çelınc and was cleared before its owner ever heard.
        const owner = await currentOwnerId();
        const failed = (await readQueue()).filter(
          (item) => item.failedReason && (!item.ownerId || item.ownerId === owner)
        );
        const [first] = failed;
        if (first) {
          // the server refused these for good; say so once, then stop holding them
          const title = first.challengeTitle ?? cachedChallengeTitle(queryClient, first.challengeId);
          // "Bugün" as that çelınc counts it, the day the entry was written for
          const today = safeTodayKey(resolveTimezone(cachedChallengeTimezone(queryClient, first.challengeId), tz));
          const day = formatDayKeyFriendly(first.body.dayKey, today, addDays(today, -1));
          const reason = first.failedReason ?? 'Sunucu kabul etmedi.';
          const more = failed.length > 1 ? `\n${failed.length - 1} giriş daha gitmedi.` : '';
          toast({
            title:
              failed.length > 1
                ? `${failed.length} giriş gönderilemedi`
                : 'Bir giriş gönderilemedi',
            // which çelınc and which day: "Süre bitti" alone did not say what was lost
            body: `${title ? `“${title}” · ` : ''}${day}: ${reason}${more}`,
            kind: 'danger',
            durationMs: 8000,
          });
          // only the ones just told: a refusal landing meanwhile waits for its own toast
          await clearFailed(failed.map((item) => item.id));
        }
      } catch {
        // the queue keeps the entries; we try again on the next foreground
      }
    };

    // local reminders: a check-in deadline and the final hour of each challenge
    // (or none at all, when Ayarlar switched them off)
    const scheduleReminders = async () => {
      try {
        await refreshReminders(makeClient(), level, tz);
      } catch {
        // reminders are a nicety; never block on them
      }
    };

    replanReminders.current = scheduleReminders;
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
      // an app parked in the background for days never comes to the front
      await scheduleReminders();
    });
    void registerBackgroundSync();

    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void syncSteps();
      void drain();
      void scheduleReminders();
    });

    // A "Geldim" parked while the app stays on screen waited for the next
    // foreground: tapped two minutes before the deadline during a short outage,
    // it went up only once the screen was switched off and on, and the server,
    // which judges such a check-in when it arrives, stored it late. Every 15 s
    // on screen an entry that never got an answer goes as soon as /health
    // does. Only those: one a 5xx already counted keeps the foreground and
    // background cadence, or a server answering 500 would use up its eight
    // tries in two minutes; a photo the server holds back waits its hour
    // (`photoHeldSince`) instead of going up four times a minute. Nothing
    // parked, nothing asked: an idle phone sends no traffic. A refusal of this
    // account waiting for its toast is told on the same tick.
    let alive = true;
    let retrying = false;
    const retryParked = async () => {
      if (retrying || AppState.currentState !== 'active') return;
      retrying = true;
      try {
        const [queue, owner] = await Promise.all([readQueue(), currentOwnerId()]);
        const waiting = queue.some(
          (item) =>
            !item.failedReason &&
            item.attempts === 0 &&
            !item.photoHeldSince &&
            (!item.ownerId || item.ownerId === owner)
        );
        // A refusal a flush outside this bridge left (a pull, a write's own
        // flush) waited for the next foreground: the drain tells it now, while
        // a lost photo can still be entered again today. The flush skips a
        // refused entry, so on its own it asks the server nothing.
        const refused = queue.some((item) => item.failedReason && (!item.ownerId || item.ownerId === owner));
        if (!waiting && !refused) return;
        // a few bytes first: the flush would start with a photo's upload when
        // one is first in line
        if (waiting) await makeClient().health();
        if (alive) await drain();
      } catch {
        // no answer: the next tick asks again
      } finally {
        retrying = false;
      }
    };
    const parkedRetry = setInterval(() => void retryParked(), PARKED_RETRY_MS);

    return () => {
      alive = false;
      clearInterval(parkedRetry);
      stopTracking();
      setBackgroundHandler(null);
      if (replanReminders.current === scheduleReminders) replanReminders.current = null;
      sub.remove();
    };
  }, [token, serverUrl, makeClient, queryClient, level, tz, refreshMe, toast, onboarding]);

  return null;
}
