import { TAGLINE, pickTaunt, renderTaunt, t, type TauntVars, type VulgarityLevel } from '@koydum/shared';
import * as Application from 'expo-application';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useUpdateMe } from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { ApiError } from '@/lib/api';
import { serverUrlIsEditable } from '@/lib/config';
import { registerForPush, type PushRegistration } from '@/services/notifications';
import {
  getStepAvailability,
  openHealthConnectSettingsIfPossible,
  requestStepPermission,
  type StepAvailability,
} from '@/services/steps';
import { deviceTimezone, useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { confirmTr } from '@/utils/confirm';
import { CUSTOM_TAUNT_CEILING_NOTE } from '@/utils/levelCopy';

const PREVIEW_VARS: TauntVars = {
  winner: 'Mustafa',
  loser: 'sen',
  metric: 'adım',
  winnerScore: '12.430',
  loserScore: '4.201',
  diff: '8.229',
  unit: 'adım',
  challenge: 'Haftalık Adım',
};

const LEVELS: { value: VulgarityLevel; label: string; emoji: string }[] = [
  { value: 1, label: 'Nazik', emoji: '🙂' },
  { value: 2, label: 'Delikanlı', emoji: '😏' },
  { value: 3, label: 'Ağır Abi', emoji: '🍆' },
];

/**
 * Who each level IS, not how it talks. The middle one used to be called "Argo",
 * which is a way of speaking rather than a character — a nazik adam and an ağır
 * abi can both use argo, so it never belonged on this scale.
 */
const LEVEL_CHARACTER: Record<VulgarityLevel, string> = {
  1: 'Kırmaz, dalga geçmez, düz konuşur. Aile grubuna da girer, iş arkadaşına da.',
  2: 'Laf sokar ama küfretmez. Kankasına "yedin lan" der, sonra sırtına vurur. Çoğu insanın yeri burası.',
  3: 'Ağzı bozuk, yumuşatmaz, geri de almaz. Kaldırabilenler için.',
};

const PUSH_REASONS: Record<NonNullable<PushRegistration['reason']>, string> = {
  web: 'Tarayıcıda push bildirimi yok. Telefondaki uygulamada çalışır, burada uygulama içi bildirim görürsün.',
  simulator:
    'Simülatör/emülatör push token alamaz. Gerçek bir telefonda dene, orada sorunsuz çalışır.',
  denied:
    'Bildirim iznini vermemişsin. Telefon ayarlarından KOYDUM’a bildirim izni ver, sonra “tekrar dene”ye bas.',
  'expo-go-android':
    'Expo Go’da Android push çalışmıyor (Expo’nun kuralı). Uygulama açıkken bildirimleri yine görürsün. Gerçek push için development build gerekiyor.',
  'no-project-id':
    'EAS proje kimliği yok. Bilgisayarda “eas init” çalıştırıp uygulamayı yeniden derlemen lazım.',
  unavailable:
    'Bu sürümde bildirim modülü yüklenemedi. Uygulama içi bildirimler ve gelen kutusu çalışmaya devam eder.',
  error: 'Bildirim servisi hata verdi.',
};

const STEP_REASONS: Record<
  Extract<StepAvailability, { available: false }>['reason'],
  string
> = {
  web: 'Tarayıcıda adım sayacı yok. Adım çelınclarında adımını elle girebilirsin.',
  'no-sensor': 'Bu cihazda adım sensörü bulamadım. Adımları elle gireceksin.',
  denied: 'Hareket/aktivite izni verilmemiş. İzni ver, adımların otomatik sayılsın.',
  'health-connect-missing':
    'Health Connect kurulu değil. Kurup KOYDUM’a adım okuma izni verirsen günlük adımlar otomatik gelir.',
  error: 'Adım sensörüne bakarken bir hata çıktı.',
};

const PLATFORM: 'ios' | 'android' | 'web' =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

const HOURS: (number | null)[] = [null, ...Array.from({ length: 24 }, (_, i) => i)];

export default function SettingsScreen() {
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const serverUrl = useAuth((s) => s.serverUrl);
  const serverEditable = serverUrlIsEditable();
  const level = useLevel();
  const api = useApi();
  const toast = useToast();
  const updateMe = useUpdateMe();

  /**
   * The picker shows the account's level, with a short-lived optimistic
   * override while the PATCH is in flight. Seeding state from `me` once would
   * freeze a stale level on the screen: `me` starts from the storage cache and
   * is refreshed right after boot, and it also changes when the level was
   * edited on another device.
   */
  const [levelOverride, setLevelOverride] = useState<VulgarityLevel | null>(null);
  const [push, setPush] = useState<PushRegistration | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [steps, setSteps] = useState<StepAvailability | null>(null);
  const [stepsBusy, setStepsBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const pendingLevel: VulgarityLevel = levelOverride ?? me?.vulgarityMax ?? 2;
  const preview = renderTaunt(pickTaunt('win', pendingLevel, 1), PREVIEW_VARS);
  const deviceTz = deviceTimezone();
  const version = Application.nativeApplicationVersion ?? (Platform.OS === 'web' ? 'web' : '—');
  const build = Application.nativeBuildVersion;

  const refreshPush = async () => {
    setPushBusy(true);
    try {
      const result = await registerForPush();
      setPush(result);
      if (result.token) {
        try {
          await api.setPushToken({ token: result.token, platform: PLATFORM });
        } catch {
          // the inbox still works without a registered token
        }
      }
    } finally {
      setPushBusy(false);
    }
  };

  const refreshSteps = async () => {
    const next = await getStepAvailability();
    setSteps(next);
  };

  // Read on mount. Inlined rather than calling the two helpers so nothing sets
  // state synchronously inside the effect, and a screen closed mid-read stops.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [pushResult, stepResult] = await Promise.all([
        registerForPush(),
        getStepAvailability(),
      ]);
      if (cancelled) return;
      setPush(pushResult);
      setSteps(stepResult);
      if (pushResult.token) {
        try {
          await api.setPushToken({ token: pushResult.token, platform: PLATFORM });
        } catch {
          // the inbox still works without a registered token
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = (body: Parameters<typeof updateMe.mutate>[0], okMessage: string) => {
    updateMe.mutate(body, {
      onSuccess: () => toast({ title: okMessage, kind: 'success' }),
      onError: (err) =>
        toast({
          title: 'Kaydedilemedi',
          body: err instanceof ApiError ? err.message : undefined,
          kind: 'danger',
        }),
    });
  };

  const chooseLevel = (next: VulgarityLevel) => {
    setLevelOverride(next);
    updateMe.mutate(
      { vulgarityMax: next },
      {
        onSuccess: () => toast({ title: 'Seviye kaydedildi', kind: 'success' }),
        onError: (err) =>
          toast({
            title: 'Kaydedilemedi',
            body: err instanceof ApiError ? err.message : undefined,
            kind: 'danger',
          }),
        // whatever happened, the store is now the truth again
        onSettled: () => setLevelOverride(null),
      }
    );
  };

  const chooseHour = (hour: number | null) => {
    save(
      { reminderHour: hour },
      hour === null ? 'Hatırlatma kapatıldı' : `Hatırlatma ${String(hour).padStart(2, '0')}:00`
    );
  };

  const syncTimezone = () => {
    if (me?.timezone === deviceTz) {
      toast({ title: 'Zaten güncel', body: deviceTz, kind: 'info' });
      return;
    }
    save({ timezone: deviceTz }, `Saat dilimi: ${deviceTz}`);
  };

  const askStepPermission = async () => {
    setStepsBusy(true);
    try {
      const granted = await requestStepPermission();
      await refreshSteps();
      toast({
        title: granted ? 'İzin alındı' : 'İzin verilmedi',
        body: granted ? 'Adımların artık otomatik sayılabilir.' : 'Telefon ayarlarından da verebilirsin.',
        kind: granted ? 'success' : 'danger',
      });
    } finally {
      setStepsBusy(false);
    }
  };

  const openHealthConnect = async () => {
    const opened = await openHealthConnectSettingsIfPossible();
    if (!opened) {
      toast({
        title: 'Health Connect açılamadı',
        body: 'Google Play’den Health Connect’i kurman gerekebilir.',
        kind: 'danger',
      });
    }
  };

  const changeServer = async () => {
    const ok = await confirmTr(
      'Sunucu adresi',
      'Adresi değiştirmek için oturumun kapanması gerekiyor. Sonra giriş ekranından yeni adresi yazarsın. Çıkış yapayım mı?',
      'Çıkış yap ve değiştir'
    );
    if (!ok) return;
    await logout();
    router.replace('/(auth)/server');
  };

  const doLogout = async () => {
    const ok = await confirmTr('Çıkış yap', t('logout_confirm', level), 'Çıkış yap');
    if (!ok) return;
    await logout();
  };

  const deleteAccount = async () => {
    const first = await confirmTr(
      'Hesabı sil',
      'Çelınclar, skorlar, rozetler, laf soktukların… hepsi gidecek. Devam edeyim mi?',
      'Devam et'
    );
    if (!first) return;
    const second = await confirmTr(
      'Son kez soruyorum',
      'Bu geri alınamaz. Hesabı gerçekten silmemi istiyor musun?',
      'Evet, sil'
    );
    if (!second) return;

    setDeleting(true);
    try {
      await api.deleteMe();
      await logout();
    } catch (err) {
      toast({
        title: 'Hesap silinemedi',
        body: err instanceof ApiError ? err.message : undefined,
        kind: 'danger',
      });
    } finally {
      setDeleting(false);
    }
  };

  const pushLine = (): { label: string; color: string; detail: string } => {
    if (!push) return { label: 'Bakılıyor…', color: Colors.textMuted, detail: 'Bildirim durumu kontrol ediliyor.' };
    if (push.token) {
      return {
        label: 'Açık',
        color: Colors.success,
        detail: 'Bildirimler telefonuna düşüyor.',
      };
    }
    const reason = push.reason ?? 'error';
    const detail = PUSH_REASONS[reason];
    return {
      label: reason === 'expo-go-android' ? 'Kısıtlı' : 'Kapalı',
      color: reason === 'expo-go-android' ? Colors.yellow : Colors.danger,
      detail: push.detail ? `${detail} (${push.detail})` : detail,
    };
  };

  const pushStatus = pushLine();

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'))}
          hitSlop={12}>
          <Text variant="small" color={Colors.accent} bold>
            ‹ Geri
          </Text>
        </Pressable>
        <Text variant="title">Ayarlar</Text>
      </View>

      {/* ------------------------------------------------------- vulgarity */}
      <Card>
        <Text variant="label">{t('settings_vulgarity_label', pendingLevel)}</Text>
        <View style={styles.block}>
          <SegmentedControl options={LEVELS} value={pendingLevel} onChange={chooseLevel} />
          <Text variant="small">{LEVEL_CHARACTER[pendingLevel]}</Text>
          <Text variant="tiny" muted>
            Hazır laflar bu seviyeyi aşamaz: ağır abi bir kankan bile sana ancak bu kadar koyabilir.
          </Text>
          <Text variant="tiny" faint>
            {CUSTOM_TAUNT_CEILING_NOTE}
          </Text>
          <TauntBubble
            title={preview.title}
            body={preview.body}
            fromName="Mustafa"
            fromEmoji="🔥"
            timeLabel="önizleme"
            loud={pendingLevel === 3}
          />
        </View>
      </Card>

      {/* -------------------------------------------------------- reminder */}
      <Card>
        <Text variant="label">Günlük hatırlatma</Text>
        <Text variant="tiny" muted style={styles.blockTop}>
          Skorun sıfırsa seni dürtelim mi, kaçta?
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.hours}>
          {HOURS.map((hour) => {
            const selected = (me?.reminderHour ?? null) === hour;
            return (
              <Chip
                key={hour === null ? 'off' : hour}
                label={hour === null ? 'kapalı' : `${String(hour).padStart(2, '0')}:00`}
                color={hour === null ? Colors.textMuted : Colors.yellow}
                selected={selected}
                onPress={() => chooseHour(hour)}
              />
            );
          })}
        </ScrollView>
      </Card>

      {/* -------------------------------------------------------- timezone */}
      <Card>
        <Text variant="label">Saat dilimi</Text>
        <View style={styles.rowBetween}>
          <View style={styles.rowText}>
            <Text variant="body" bold>
              {me?.timezone ?? deviceTz}
            </Text>
            <Text variant="tiny" muted>
              Günler bu saat dilimine göre sayılıyor. Cihazın: {deviceTz}
            </Text>
          </View>
          <Button
            title="Cihazdan güncelle"
            variant="secondary"
            size="sm"
            onPress={syncTimezone}
            loading={updateMe.isPending}
          />
        </View>
      </Card>

      {/* ------ server: only when no address was baked into the build ------ */}
      {serverEditable ? (
      <Card>
        <Text variant="label">Sunucu</Text>
        <Pressable accessibilityRole="button" onPress={() => void changeServer()}>
          <View style={styles.rowBetween}>
            <View style={styles.rowText}>
              <Text variant="body" bold numberOfLines={1}>
                {serverUrl.replace(/^https?:\/\//, '')}
              </Text>
              <Text variant="tiny" muted>
                Adresi değiştirmek için dokun (çıkış yapman gerekir).
              </Text>
            </View>
            <Text variant="title" muted>
              ›
            </Text>
          </View>
        </Pressable>
      </Card>
      ) : null}

      {/* ------------------------------------------------------------ push */}
      <Card>
        <View style={styles.rowBetween}>
          <Text variant="label">Bildirimler</Text>
          <Chip label={pushStatus.label} color={pushStatus.color} size="sm" />
        </View>
        <Text variant="tiny" muted style={styles.blockTop}>
          {pushStatus.detail}
        </Text>
        <Button
          title="Tekrar dene"
          variant="secondary"
          size="sm"
          style={styles.selfStart}
          loading={pushBusy}
          onPress={() => void refreshPush()}
        />
      </Card>

      {/* ----------------------------------------------------------- steps */}
      <Card>
        <View style={styles.rowBetween}>
          <Text variant="label">Adım sayacı</Text>
          <Chip
            label={steps ? (steps.available ? (steps.approximate ? 'Yaklaşık' : 'Açık') : 'Kapalı') : '…'}
            color={
              steps
                ? steps.available
                  ? steps.approximate
                    ? Colors.yellow
                    : Colors.success
                  : Colors.danger
                : Colors.textMuted
            }
            size="sm"
          />
        </View>
        <Text variant="tiny" muted style={styles.blockTop}>
          {!steps
            ? 'Sensöre bakıyorum…'
            : steps.available
              ? steps.source === 'health_connect'
                ? 'Health Connect’ten günlük adımların otomatik geliyor.'
                : steps.approximate
                  ? 'Adımlar uygulama açıkken sayılıyor (yaklaşık). Kesin sonuç için Health Connect kur.'
                  : 'Telefonun adım sayacı okunuyor, günlük adımların otomatik geliyor.'
              : STEP_REASONS[steps.reason] + (steps.detail ? ` (${steps.detail})` : '')}
        </Text>
        <View style={styles.buttonRow}>
          <Button
            title="İzin ver"
            variant="secondary"
            size="sm"
            loading={stepsBusy}
            onPress={() => void askStepPermission()}
          />
          {Platform.OS === 'android' &&
          steps &&
          (steps.available ? steps.approximate : steps.reason === 'health-connect-missing') ? (
            <Button
              title="Health Connect’i aç"
              variant="ghost"
              size="sm"
              onPress={() => void openHealthConnect()}
            />
          ) : null}
        </View>
      </Card>

      {/* --------------------------------------------------------- account */}
      <Card>
        <Text variant="label">Hesap</Text>
        <View style={styles.block}>
          <Text variant="tiny" muted>
            {me ? `@${me.username} · davet kodu ${me.inviteCode}` : 'Hesap bilgisi yüklenemedi.'}
          </Text>
          <Button title="Çıkış yap" variant="secondary" fullWidth onPress={() => void doLogout()} />
          <Button
            title="Hesabı sil"
            variant="danger"
            fullWidth
            loading={deleting}
            onPress={() => void deleteAccount()}
          />
          <Text variant="micro" faint>
            Hesabı silmek her şeyi siler: çelınclar, skorlar, rozetler, yediğin ve koyduğun ne varsa.
          </Text>
        </View>
      </Card>

      {/* ----------------------------------------------------------- about */}
      <View style={styles.about}>
        <Text variant="big" style={styles.aboutLogo}>
          KOYDUM
        </Text>
        <Text variant="small" muted center>
          {TAGLINE[level === 1 ? 'level1' : level === 3 ? 'level3' : 'level2']}
        </Text>
        <Text variant="tiny" faint center>
          Sürüm {version}
          {build ? ` (${build})` : ''} · {PLATFORM}
        </Text>
        <Text variant="micro" faint center>
          Bu uygulama eğlence ve gelişim için tasarlandı. Amacının dışına çıkarmayın, kimse
          kimseyi kırmasın.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.lg },
  header: { gap: Spacing.xs },
  block: { gap: Spacing.md, marginTop: Spacing.sm },
  blockTop: { marginTop: Spacing.sm },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  rowText: { flex: 1, gap: 2 },
  hours: { gap: Spacing.sm, paddingVertical: Spacing.sm, paddingRight: Spacing.lg },
  selfStart: { alignSelf: 'flex-start', marginTop: Spacing.md },
  buttonRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md, flexWrap: 'wrap' },
  about: {
    alignItems: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.xl,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    borderRadius: Radius.sm,
  },
  aboutLogo: { color: Colors.accentDim, letterSpacing: -1 },
});
