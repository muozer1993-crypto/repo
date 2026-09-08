import { LIMITS, getChallengeType, t } from '@koydum/shared';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Loading } from '@/components/Loading';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Sheet } from '@/components/Sheet';
import { Text } from '@/components/Text';
import { useAddEntry, useChallenge } from '@/hooks/queries';
import {
  FOCUS_PRESETS,
  GRACE_MS,
  abandon,
  createSession,
  loadSession,
  onBackground,
  onForeground,
  saveSession,
  snapshot,
  tick,
  watchAppState,
  type FocusSession,
} from '@/services/focus';
import { useTimezone } from '@/hooks/useTimezone';
import { USE_NATIVE_DRIVER } from '@/utils/animation';
import { useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { safeTodayKey } from '@/utils/datetime';
import { errorText } from '@/utils/errors';
import { formatClock, formatMinutes } from '@/utils/format';

const KEEP_AWAKE_TAG = 'koydum-focus';

/** Good enough as an idempotency key; Hermes has no crypto.randomUUID. */
function makeSessionId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export default function FocusScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const level = useLevel();
  const tz = useTimezone();

  const query = useChallenge(id);
  const detail = query.data;
  const type = detail ? getChallengeType(detail.challenge.typeKey) : undefined;
  const addEntry = useAddEntry(id);

  const [restored, setRestored] = useState(false);
  const [session, setSession] = useState<FocusSession | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [preset, setPreset] = useState<number>(FOCUS_PRESETS[1]);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [savedMinutes, setSavedMinutes] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const postedRef = useRef<string | null>(null);
  const celebrate = useRef(new Animated.Value(0)).current;

  /* ------------------------------------------------------------ restore */
  useEffect(() => {
    let alive = true;
    void loadSession(Date.now()).then((stored) => {
      if (!alive) return;
      if (stored && stored.challengeId === id) setSession(stored);
      setRestored(true);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  /* --------------------------------------------------------- persistence */
  useEffect(() => {
    if (!restored || !session) return;
    void saveSession(session);
  }, [restored, session]);

  /* --------------------------------------------------------------- tick */
  const live = session?.status === 'running' || session?.status === 'paused';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      setSession((prev) => (prev ? tick(prev, stamp) : prev));
    }, 1000);
    return () => clearInterval(timer);
  }, [live]);

  /* ----------------------------------------------------------- appstate */
  useEffect(() => {
    const unsubscribe = watchAppState((state) => {
      const stamp = Date.now();
      setNow(stamp);
      setSession((prev) => {
        if (!prev) return prev;
        return state === 'active' ? onForeground(prev, stamp) : onBackground(prev, stamp);
      });
    });
    return unsubscribe;
  }, []);

  /* --------------------------------------------------------- keep awake */
  const running = session?.status === 'running';
  useEffect(() => {
    if (!running) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [running]);

  /* ------------------------------------------------------- post on done */
  const status = session?.status;
  useEffect(() => {
    if (status !== 'done' || !session) return;
    if (postedRef.current === session.sessionId) return;
    postedRef.current = session.sessionId;
    if (Platform.OS !== 'web') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    Animated.sequence([
      Animated.timing(celebrate, { toValue: 1, duration: 320, useNativeDriver: USE_NATIVE_DRIVER }),
      Animated.timing(celebrate, { toValue: 0.85, duration: 220, useNativeDriver: USE_NATIVE_DRIVER }),
    ]).start();
    void submit(session);
    // `submit` closes over fresh state on every render; the guard above makes it run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const submit = async (target: FocusSession) => {
    const earned = snapshot(target, Date.now()).earnedMinutes;
    if (earned < LIMITS.FOCUS_MIN_MINUTES) {
      setSaveError('Tam dakika bile dolmadı, kaydedecek bir şey yok.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await addEntry.mutateAsync({
        dayKey: safeTodayKey(tz),
        value: Math.min(earned, LIMITS.FOCUS_MAX_MINUTES),
        source: 'focus',
        sessionId: target.sessionId,
        clientTime: new Date().toISOString(),
      });
      setSavedMinutes(earned);
    } catch (error) {
      setSaveError(errorText(error, 'Dakikalar sunucuya gitmedi.'));
    } finally {
      setSaving(false);
    }
  };

  const start = () => {
    const stamp = Date.now();
    postedRef.current = null;
    setSavedMinutes(null);
    setSaveError(null);
    setNow(stamp);
    setSession(createSession(id, preset, makeSessionId(), stamp));
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
  };

  const quit = () => {
    setConfirmQuit(false);
    const stamp = Date.now();
    setNow(stamp);
    setSession((prev) => (prev ? abandon(prev, stamp) : prev));
  };

  const reset = () => {
    postedRef.current = null;
    setSavedMinutes(null);
    setSaveError(null);
    setSession(null);
    void saveSession(null);
  };

  const leave = () => {
    void saveSession(null);
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/challenge/[id]', params: { id } });
  };

  /* --------------------------------------------------------------- gate */

  // a link without an id leaves the query disabled, so the spinner would never end
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.center}>
        <EmptyState
          emoji="🫥"
          title="Seans açılmadı"
          subtitle="Bu bağlantıda çelinç numarası yok. Odak seansını çelincin içinden başlat."
          actionLabel="Geri dön"
          onAction={leave}
        />
      </Screen>
    );
  }

  if (query.isPending || !restored) {
    return (
      <Screen contentStyle={styles.center}>
        <Loading label="Seans hazırlanıyor..." />
      </Screen>
    );
  }

  if (query.isError || !detail || !type) {
    return (
      <Screen scroll contentStyle={styles.center}>
        <EmptyState
          emoji="🫥"
          title="Seans açılmadı"
          subtitle={query.isError ? errorText(query.error, 'Çelinç bilgisi gelmedi.') : 'Çelinç tipi tanınmadı.'}
          actionLabel="Geri dön"
          onAction={leave}
        />
      </Screen>
    );
  }

  if (type.metricType !== 'focus_minutes') {
    return (
      <Screen scroll contentStyle={styles.center}>
        <EmptyState
          emoji="🎯"
          title="Burada odak seansı yok"
          subtitle="Bu çelinç odak dakikasıyla ölçülmüyor. Seans sadece odak çelinçlerinde çalışır."
          actionLabel="Çelince dön"
          onAction={leave}
        />
      </Screen>
    );
  }

  const snap = session ? snapshot(session, now) : null;
  const blocked = detail.challenge.status !== 'active' || detail.me?.status !== 'accepted';

  /* ------------------------------------------------------------- picker */

  if (!session || session.status === 'idle') {
    return (
      <Screen scroll contentStyle={styles.content}>
        <View style={styles.pickerHead}>
          <Text style={styles.bigEmoji}>🎯</Text>
          <Text variant="big" center>
            Odak Seansı
          </Text>
          <Text variant="small" muted center>
            {t('focus_start', level)}
          </Text>
        </View>

        <Card>
          <Text variant="label" style={styles.label}>
            Süre
          </Text>
          <SegmentedControl
            options={FOCUS_PRESETS.map((minutes) => ({ value: minutes, label: `${minutes} dk` }))}
            value={preset}
            onChange={setPreset}
          />
          <Text variant="tiny" faint style={styles.hint}>
            Uygulamadan {Math.round(GRACE_MS / 1000)} saniyeden uzun çıkarsan seans yanar. Bildirime bakmak bile
            yeter.
          </Text>
        </Card>

        {blocked ? (
          <Card edgeColor={Colors.danger}>
            <Text variant="small">
              {detail.challenge.status !== 'active'
                ? 'Çelinç aktif değil; seans süresi skora yazılmaz.'
                : 'Bu çelinçte oyuncu değilsin; önce daveti kabul et.'}
            </Text>
          </Card>
        ) : null}

        <Button
          title="Başlat"
          icon="▶️"
          size="xl"
          fullWidth
          disabled={blocked}
          onPress={start}
        />
        <Button title="Vazgeç" variant="ghost" size="md" fullWidth onPress={leave} />
      </Screen>
    );
  }

  /* ---------------------------------------------------------- finished */

  if (session.status === 'done') {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Animated.View
          style={[
            styles.pickerHead,
            { transform: [{ scale: celebrate.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.12] }) }] },
          ]}>
          <Text style={styles.bigEmoji}>🎉</Text>
          <Text variant="huge" center color={Colors.success}>
            {formatMinutes(session.targetMinutes)}
          </Text>
          <Text variant="lead" center>
            {t('focus_done', level)}
          </Text>
        </Animated.View>

        <Card edgeColor={savedMinutes !== null ? Colors.success : Colors.yellow}>
          {saving ? (
            <Loading label="Dakikalar yazılıyor..." />
          ) : savedMinutes !== null ? (
            <Text variant="small">
              {formatMinutes(savedMinutes)} skoruna eklendi. Telefon bu turu kaybetti.
            </Text>
          ) : (
            <View style={styles.retryBlock}>
              <Text variant="small" color={Colors.danger}>
                {saveError ?? 'Dakikalar henüz kaydedilmedi.'}
              </Text>
              <Button
                title="Tekrar dene"
                variant="secondary"
                size="md"
                onPress={() => void submit(session)}
              />
            </View>
          )}
        </Card>

        <Button title="Bitir" size="xl" fullWidth onPress={leave} />
        <Button
          title="Bir tur daha"
          variant="ghost"
          size="md"
          fullWidth
          onPress={reset}
        />
      </Screen>
    );
  }

  /* --------------------------------------------------------- abandoned */

  if (session.status === 'abandoned') {
    const earned = snap?.earnedMinutes ?? 0;
    return (
      <Screen scroll contentStyle={styles.content}>
        <View style={styles.pickerHead}>
          <Text style={styles.bigEmoji}>💀</Text>
          <Text variant="big" center color={Colors.danger}>
            Seans yandı
          </Text>
          <Text variant="small" muted center>
            {t('focus_abandoned', level)}
          </Text>
        </View>

        <Card>
          <Text variant="small" muted>
            Biriken süre
          </Text>
          <Text variant="huge">{formatMinutes(earned)}</Text>
          {earned >= LIMITS.FOCUS_MIN_MINUTES ? (
            savedMinutes !== null ? (
              <Text variant="small" color={Colors.success} style={styles.hint}>
                {formatMinutes(savedMinutes)} yine de skoruna yazıldı.
              </Text>
            ) : (
              <View style={styles.retryBlock}>
                <Text variant="tiny" faint>
                  Tam dakikalar hâlâ sayılabilir. Kaydedelim mi?
                </Text>
                {saveError ? (
                  <Text variant="tiny" color={Colors.danger}>
                    {saveError}
                  </Text>
                ) : null}
                <Button
                  title={`${formatMinutes(earned)} kaydet`}
                  variant="secondary"
                  size="md"
                  loading={saving}
                  onPress={() => void submit(session)}
                />
              </View>
            )
          ) : (
            <Text variant="tiny" faint style={styles.hint}>
              Bir tam dakika bile dolmadı, yazacak bir şey yok.
            </Text>
          )}
        </Card>

        <Button title="Yeniden başlat" size="lg" fullWidth onPress={reset} />
        <Button title="Çelince dön" variant="ghost" size="md" fullWidth onPress={leave} />
      </Screen>
    );
  }

  /* ------------------------------------------------------------- timer */

  const paused = session.status === 'paused';
  const graceLeft = paused && session.leftAt != null ? Math.max(0, GRACE_MS - (now - session.leftAt)) : 0;

  return (
    <Screen contentStyle={styles.timerContent}>
      <View style={styles.timerTop}>
        <Text variant="label">{detail.challenge.title || type.nameTr}</Text>
        <Text variant="tiny" faint>
          Hedef {formatMinutes(session.targetMinutes)}
        </Text>
      </View>

      <View style={[styles.dial, paused && styles.dialPaused]}>
        <Text variant="giant" style={styles.clock}>
          {formatClock(Math.ceil((snap?.remainingMs ?? 0) / 1000))}
        </Text>
        <Text variant="tiny" faint>
          {formatMinutes(snap?.earnedMinutes ?? 0)} biriktin
        </Text>
      </View>

      <View style={styles.progressWrap}>
        <ProgressBar value={snap?.progress ?? 0} color={paused ? Colors.danger : Colors.accent} height={10} />
        <Text variant="tiny" faint center>
          %{Math.round((snap?.progress ?? 0) * 100)}
        </Text>
      </View>

      {paused ? (
        <Card edgeColor={Colors.danger}>
          <Text variant="lead" center color={Colors.danger}>
            Geri dön!
          </Text>
          <Text variant="small" center muted>
            {Math.ceil(graceLeft / 1000)} saniye içinde uygulamaya dönmezsen seans yanacak.
          </Text>
        </Card>
      ) : (
        <Text variant="lead" center muted style={styles.handsOff}>
          Elini telefondan çek. Ekran açık kalsın, sen bırak.
        </Text>
      )}

      <Button title="Vazgeç" variant="ghost" size="md" fullWidth onPress={() => setConfirmQuit(true)} />

      <Sheet visible={confirmQuit} onClose={() => setConfirmQuit(false)} title="Seansı bitirelim mi?">
        <Text variant="small" muted>
          Şu ana kadar {formatMinutes(snap?.earnedMinutes ?? 0)} biriktirdin. Vazgeçersen sadece tam dakikaları
          kaydedebilirsin.
        </Text>
        <Button title="Evet, vazgeçtim" variant="danger" fullWidth onPress={quit} />
        <Button title="Devam ediyorum" variant="secondary" fullWidth onPress={() => setConfirmQuit(false)} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.xl, justifyContent: 'center' },
  center: { justifyContent: 'center' },
  pickerHead: { alignItems: 'center', gap: Spacing.sm },
  bigEmoji: { fontSize: 56 },
  label: { marginBottom: Spacing.sm },
  hint: { marginTop: Spacing.sm },
  retryBlock: { gap: Spacing.sm, marginTop: Spacing.sm },

  timerContent: { gap: Spacing.xl, justifyContent: 'center', paddingVertical: Spacing.xl },
  timerTop: { alignItems: 'center', gap: 2 },
  dial: {
    alignSelf: 'center',
    width: 260,
    height: 260,
    borderRadius: Radius.pill,
    borderWidth: 4,
    borderColor: Colors.accent,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
  },
  dialPaused: { borderColor: Colors.danger },
  clock: { letterSpacing: -2 },
  progressWrap: { gap: Spacing.sm },
  handsOff: { paddingHorizontal: Spacing.lg },
});
