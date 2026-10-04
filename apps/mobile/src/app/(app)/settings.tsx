import {
  LIMITS,
  TAGLINE,
  pickTaunt,
  renderTaunt,
  t,
  type PublicUser,
  type TauntVars,
  type VulgarityLevel,
} from '@koydum/shared';
import * as Application from 'expo-application';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Sheet } from '@/components/Sheet';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { UPDATE_HOW, useAppUpdate } from '@/components/UpdateBanner';
import { useBlocked, useUnblock, useUpdateMe } from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { useTimezone } from '@/hooks/useTimezone';
import { ApiError } from '@/lib/api';
import { normalizeServerUrl, serverUrlIsEditable } from '@/lib/config';
import {
  getBackgroundHealth,
  openAppSettings,
  openExactAlarmSettings,
  requestBatteryExemption,
  type BackgroundHealth,
} from '@/services/deviceHealth';
import { serverFromInviteLink } from '@/services/invite';
import { registerForPush, type PushRegistration } from '@/services/notifications';
import { deviceRemindersEnabled, refreshReminders, setDeviceRemindersEnabled } from '@/services/reminders';
import {
  getScreenTimeAvailability,
  requestScreenTimePermission,
  type ScreenTimeAvailability,
} from '@/services/screenTime';
import { moveSession } from '@/services/serverMove';
import {
  getStepAvailability,
  openHealthConnectSettingsIfPossible,
  requestStepPermission,
  type StepAvailability,
} from '@/services/steps';
import { deviceTimezone, useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { confirmTr } from '@/utils/confirm';
import { CUSTOM_TAUNT_CEILING_NOTE, SERVER_MOVED, byLevel } from '@/utils/levelCopy';

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
    'Bildirim iznini vermemişsin. “Ayarları aç”a bas, açılan sayfada KOYDUM’un bildirimlerini aç ve geri gel.',
  'expo-go-android':
    'Expo Go’da Android push çalışmıyor (Expo’nun kuralı). Uygulama açıkken bildirimleri yine görürsün. Gerçek push için development build gerekiyor.',
  'no-project-id':
    'EAS proje kimliği yok. Bilgisayarda “eas init” çalıştırıp uygulamayı yeniden derlemen lazım.',
  unavailable:
    'Bu sürümde bildirim modülü yüklenemedi. Uygulama içi bildirimler ve gelen kutusu çalışmaya devam eder.',
  'no-fcm':
    'Anlık push için bu sürümde Firebase ayarı yok. Bildirimler yine geliyor: uygulama arka planda aşağı yukarı 15 dakikada bir gelen kutuna bakıp yeni geleni telefonuna düşürüyor. Anlık olsun istersen README’deki Firebase adımları.',
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

const SCREEN_TIME_REASONS: Record<Extract<ScreenTimeAvailability, { available: false }>['reason'], string> = {
  ios: 'iPhone ekran süresini hiçbir uygulamaya vermiyor, Apple kuralı. Ekran süresi çelıncında değeri ekran görüntüsüyle giriyorsun.',
  web: 'Tarayıcıda ekran süresi okunamıyor.',
  'needs-native-module':
    'Bu sürüm ekran süresini okuyamıyor (Expo Go). Gerçek APK’da telefondan otomatik gelir.',
  permission:
    'Kullanım erişimi verilmemiş. İzni verirsen ekran süren telefondan okunur, ekran görüntüsüyle uğraşmazsın.',
  error: 'Ekran süresi okunurken bir hata çıktı.',
};

const PLATFORM: 'ios' | 'android' | 'web' =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

const HOURS: (number | null)[] = [null, ...Array.from({ length: 24 }, (_, i) => i)];

/** The two server-sent extras the reader can switch off; everything else always arrives. */
type ServerPref = 'nudgesEnabled' | 'recapEnabled';

const PREF_SAVED: Record<ServerPref, { on: string; off: string }> = {
  nudgesEnabled: { on: 'Dürtme açıldı', off: 'Dürtme kapatıldı' },
  recapEnabled: { on: 'Haftalık özet açıldı', off: 'Haftalık özet kapatıldı' },
};

/** One switch under "Bildirim tercihleri": what it does on the left, the switch on the right. */
function PrefRow({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.prefRow}>
      <View style={styles.rowText}>
        <Text variant="body" bold>
          {title}
        </Text>
        <Text variant="tiny" muted>
          {detail}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={title}
        trackColor={{ false: Colors.surfaceHigh, true: Colors.accentDim }}
        thumbColor={value ? Colors.accent : Colors.textFaint}
        ios_backgroundColor={Colors.surfaceHigh}
      />
    </View>
  );
}

/** One line under "Arka plan": what it is and where it stands, and the button while it is not fine. */
function HealthRow({
  title,
  ok,
  okLabel,
  offLabel,
  detail,
  action,
  onAction,
}: {
  title: string;
  ok: boolean;
  okLabel: string;
  offLabel: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.prefRow}>
      <View style={styles.rowText}>
        <View style={styles.rowBetween}>
          <Text variant="body" bold>
            {title}
          </Text>
          <Chip label={ok ? okLabel : offLabel} color={ok ? Colors.success : Colors.yellow} size="sm" />
        </View>
        <Text variant="tiny" muted>
          {detail}
        </Text>
        {ok ? null : (
          <Button title={action} variant="secondary" size="sm" style={styles.selfStart} onPress={onAction} />
        )}
      </View>
    </View>
  );
}

interface PasswordErrors {
  current?: string;
  next?: string;
  repeat?: string;
}

/**
 * "Şifreni değiştir": the place a sign-up "123456", or the temporary password
 * the owner handed out with `npm run yonet -- sifre`, becomes a real one. The
 * server answers a wrong current password with a 400, never a 401, so a typo
 * here does not log anybody out.
 */
function PasswordSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const api = useApi();
  const setSession = useAuth((s) => s.setSession);
  const level = useLevel();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [busy, setBusy] = useState(false);

  // nothing typed here should still be sitting in the fields next time
  const close = () => {
    setCurrent('');
    setNext('');
    setRepeat('');
    setErrors({});
    onClose();
  };

  const submit = async () => {
    const found: PasswordErrors = {};
    if (!current) found.current = 'Mevcut şifreni yaz.';
    if (next.length < LIMITS.PASSWORD_MIN) found.next = `Yeni şifre en az ${LIMITS.PASSWORD_MIN} karakter olmalı.`;
    else if (next.length > LIMITS.PASSWORD_MAX) found.next = `Yeni şifre en fazla ${LIMITS.PASSWORD_MAX} karakter olabilir.`;
    if (repeat !== next) found.repeat = 'İkisi aynı değil, bir daha yaz.';
    setErrors(found);
    if (found.current || found.next || found.repeat) return;

    setBusy(true);
    try {
      const result = await api.changePassword({ currentPassword: current, newPassword: next });
      await setSession(result.token, result.me);
      close();
      toast({
        title: byLevel(level, 'Şifren değişti', 'Tamamdır, yeni şifre işlendi', 'Oldu. Bu sefer unutma 🍆'),
        kind: 'success',
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'wrong_password') setErrors({ current: err.message });
      else if (err instanceof ApiError && err.code === 'same_password') setErrors({ next: err.message });
      else {
        toast({
          title: 'Şifre değişmedi',
          body: err instanceof ApiError ? err.message : undefined,
          kind: 'danger',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={close} title="Şifreni değiştir">
      <Input
        label="Mevcut şifre"
        placeholder="••••••"
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        value={current}
        onChangeText={(text) => {
          setCurrent(text);
          setErrors((prev) => ({ ...prev, current: undefined }));
        }}
        returnKeyType="next"
        error={errors.current}
      />
      <Input
        label="Yeni şifre"
        placeholder="••••••"
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        value={next}
        onChangeText={(text) => {
          setNext(text);
          setErrors((prev) => ({ ...prev, next: undefined }));
        }}
        maxLength={LIMITS.PASSWORD_MAX}
        returnKeyType="next"
        error={errors.next}
        hint={`En az ${LIMITS.PASSWORD_MIN} karakter.`}
      />
      <Input
        label="Yeni şifre (tekrar)"
        placeholder="••••••"
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        value={repeat}
        onChangeText={(text) => {
          setRepeat(text);
          setErrors((prev) => ({ ...prev, repeat: undefined }));
        }}
        maxLength={LIMITS.PASSWORD_MAX}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        error={errors.repeat}
      />
      <Button title="Değiştir" size="lg" fullWidth loading={busy} onPress={() => void submit()} />
      <Text variant="micro" faint>
        Başka bir telefonda açık kalan oturumun kapanmaz.
      </Text>
    </Sheet>
  );
}

/**
 * "Sunucu": a tunnel restart gives the same server a new address, and that
 * must not cost a logout any more. The sheet takes a bare address or whatever
 * invite link a friend sent (after a restart that link is how the new address
 * travels) and moves the session when the server there is this one. Only a
 * genuinely different server still means logging out, and only after asking.
 */
function ServerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const serverUrl = useAuth((s) => s.serverUrl);
  const setServerUrl = useAuth((s) => s.setServerUrl);
  const logout = useAuth((s) => s.logout);
  const level = useLevel();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setValue('');
    setError(null);
    onClose();
  };

  const connect = async () => {
    const url = serverFromInviteLink(value) ?? normalizeServerUrl(value);
    if (!url) {
      setError('Bunu adres olarak okuyamadım. Kankanın attığı bağlantıyı olduğu gibi yapıştır.');
      return;
    }
    if (url === normalizeServerUrl(serverUrl)) {
      setError('Zaten bu adrese bağlısın.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await moveSession(url);
    setBusy(false);
    if (result === 'moved') {
      close();
      toast({ title: SERVER_MOVED[level], kind: 'success' });
      return;
    }
    if (result === 'unreachable') {
      setError('Bu adrese ulaşamadım. Sunucu açık mı, adres doğru mu?');
      return;
    }
    const ok = await confirmTr(
      'Bu başka bir sunucu',
      'Hesabın o sunucuda geçmiyor. Oraya geçmek için bu hesaptan çıkış yapman lazım; orada hesabın varsa giriş yaparsın, yoksa yeni hesap açarsın. Çıkış yapayım mı?',
      'Çıkış yap ve geç'
    );
    if (!ok) return;
    close();
    await logout();
    // it answered /health a moment ago, so the login screen can start there
    await setServerUrl(url);
    router.replace('/(auth)/login');
  };

  return (
    <Sheet visible={visible} onClose={close} title="Sunucu adresi">
      <Input
        label="Yeni adres ya da davet bağlantısı"
        placeholder="https://….trycloudflare.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={Platform.OS === 'web' ? 'default' : 'url'}
        value={value}
        onChangeText={(text) => {
          setValue(text);
          setError(null);
        }}
        returnKeyType="go"
        onSubmitEditing={() => void connect()}
        error={error}
        hint="Kankan yeni bir davet bağlantısı attıysa olduğu gibi yapıştır, adresi ben ayıklarım."
      />
      <Button title="Bağlan" size="lg" fullWidth loading={busy} onPress={() => void connect()} />
      <Text variant="micro" faint>
        Aynı sunucuysa hesabın yerinde kalır, çıkış yapmazsın. Başka bir sunucuysa önce sorarım.
      </Text>
    </Sheet>
  );
}

/**
 * "Engellediklerin": a block made in a heated moment used to be for ever. The
 * blocked person's profile 404s and search hides them, so this list is the one
 * place left to take it back. It holds only the blocks you placed; a block on
 * you stays as invisible as the rest of it.
 */
function BlockedCard() {
  const blocked = useBlocked();
  const unblock = useUnblock();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const users = blocked.data ?? [];

  const lift = async (user: PublicUser) => {
    const ok = await confirmTr(
      'Engeli kaldır',
      `${user.displayName} seni yeniden bulabilir. Kanka olmak için yeniden istek atman lazım.`,
      'Kaldır'
    );
    if (!ok) return;
    setBusyId(user.id);
    unblock.mutate(user.id, {
      onSuccess: () => toast({ title: 'Engel kalktı', kind: 'success' }),
      onError: (err) =>
        toast({
          title: 'Engel kalkmadı',
          body: err instanceof ApiError ? err.message : undefined,
          kind: 'danger',
        }),
      onSettled: () => setBusyId(null),
    });
  };

  return (
    <Card>
      <Text variant="label">Engellediklerin</Text>
      {blocked.isPending ? (
        <Text variant="tiny" muted style={styles.blockTop}>
          Bakıyorum…
        </Text>
      ) : blocked.isError ? (
        <>
          <Text variant="tiny" muted style={styles.blockTop}>
            {blocked.error instanceof ApiError ? blocked.error.message : 'Liste gelmedi.'}
          </Text>
          <Button
            title="Tekrar dene"
            variant="secondary"
            size="sm"
            style={styles.selfStart}
            onPress={() => void blocked.refetch()}
          />
        </>
      ) : users.length === 0 ? (
        <Text variant="tiny" muted style={styles.blockTop}>
          Kimseyi engellemedin.
        </Text>
      ) : (
        <View style={styles.block}>
          {users.map((user) => (
            <View key={user.id} style={styles.rowBetween}>
              <Avatar emoji={user.avatarEmoji} name={user.displayName} size={36} />
              <View style={styles.rowText}>
                <Text variant="small" bold numberOfLines={1}>
                  {user.displayName}
                </Text>
                <Text variant="tiny" faint numberOfLines={1}>
                  @{user.username}
                </Text>
              </View>
              <Button
                title="Engeli kaldır"
                variant="secondary"
                size="sm"
                loading={busyId === user.id}
                disabled={busyId !== null}
                onPress={() => void lift(user)}
              />
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

export default function SettingsScreen() {
  const me = useAuth((s) => s.me);
  const logout = useAuth((s) => s.logout);
  const serverUrl = useAuth((s) => s.serverUrl);
  const serverEditable = serverUrlIsEditable();
  const level = useLevel();
  const tz = useTimezone();
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
  // the same short-lived override for the two notification switches
  const [prefOverride, setPrefOverride] = useState<Partial<Record<ServerPref, boolean>>>({});
  /** The phone's own deadline alerts; null until storage has answered. */
  const [deviceAlerts, setDeviceAlerts] = useState<boolean | null>(null);
  const [push, setPush] = useState<PushRegistration | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [steps, setSteps] = useState<StepAvailability | null>(null);
  const [stepsBusy, setStepsBusy] = useState(false);
  const [screenTime, setScreenTime] = useState<ScreenTimeAvailability | null>(null);
  /** Android's battery and alarm switches; null where there are none (iOS, web, Expo Go) */
  const [background, setBackground] = useState<BackgroundHealth | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);

  const pendingLevel: VulgarityLevel = levelOverride ?? me?.vulgarityMax ?? 2;
  const preview = renderTaunt(pickTaunt('win', pendingLevel, 1), PREVIEW_VARS);
  const deviceTz = deviceTimezone();
  const version = Application.nativeApplicationVersion ?? (Platform.OS === 'web' ? 'web' : '—');
  // the settings screen shows it even when the home card was closed
  const update = useAppUpdate();
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
      const [pushResult, stepResult, screenTimeResult, alertsOn, backgroundResult] = await Promise.all([
        registerForPush(),
        getStepAvailability(),
        getScreenTimeAvailability(),
        deviceRemindersEnabled(),
        getBackgroundHealth(),
      ]);
      if (cancelled) return;
      setPush(pushResult);
      setSteps(stepResult);
      setScreenTime(screenTimeResult);
      setDeviceAlerts(alertsOn);
      setBackground(backgroundResult);
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

  const choosePref = (pref: ServerPref, on: boolean) => {
    setPrefOverride((prev) => ({ ...prev, [pref]: on }));
    updateMe.mutate(pref === 'nudgesEnabled' ? { nudgesEnabled: on } : { recapEnabled: on }, {
      onSuccess: () => toast({ title: PREF_SAVED[pref][on ? 'on' : 'off'], kind: 'success' }),
      onError: (err) =>
        toast({
          title: 'Kaydedilemedi',
          body: err instanceof ApiError ? err.message : undefined,
          kind: 'danger',
        }),
      onSettled: () => setPrefOverride((prev) => ({ ...prev, [pref]: undefined })),
    });
  };

  // Stored on this phone only: the server never sees these alerts.
  const chooseDeviceAlerts = async (on: boolean) => {
    setDeviceAlerts(on);
    await setDeviceRemindersEnabled(on);
    toast({ title: on ? 'Saatli uyarılar açıldı' : 'Saatli uyarılar kapatıldı', kind: 'success' });
    try {
      // off clears what is already scheduled; on puts it back without waiting
      // for the app to come to the front again
      await refreshReminders(api, level, tz);
    } catch {
      // offline: the bridge does it on the next foreground
    }
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
      if (granted) {
        toast({ title: 'İzin alındı', body: 'Adımların artık otomatik sayılabilir.', kind: 'success' });
      } else if (PLATFORM === 'web') {
        toast({ title: 'İzin verilmedi', body: STEP_REASONS.web, kind: 'danger' });
      } else {
        // after the second no Android stops showing the dialog; a tap on the
        // toast opens the page where the switch still is
        toast({
          title: 'İzin verilmedi',
          body: 'Dokun, ayarları açayım: Fiziksel aktivite iznini aç.',
          kind: 'danger',
          durationMs: 8000,
          onPress: () => void openAppSettings(),
        });
      }
    } finally {
      setStepsBusy(false);
    }
  };

  // The notification switch lives in system settings too: open KOYDUM's page,
  // look again when the user comes back.
  const openPushSettings = async () => {
    if (!(await openAppSettings())) {
      toast({
        title: 'Ayarlar açılamadı',
        body: 'Ayarlar → Uygulamalar → KOYDUM → Bildirimler yolundan aç.',
        kind: 'danger',
      });
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      sub.remove();
      void refreshPush();
    });
  };

  // The switch lives in system settings; we can only open the page and look
  // again when the user comes back.
  const askScreenTimePermission = async () => {
    const opened = await requestScreenTimePermission();
    if (!opened) {
      toast({
        title: 'Ayarlar açılamadı',
        body: 'Ayarlar → Uygulamalar → Özel uygulama erişimi → Kullanım erişimi yolunu kendin dene.',
        kind: 'danger',
      });
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      sub.remove();
      void getScreenTimeAvailability().then(setScreenTime);
    });
  };

  // Both switches live in system pages too: open one, look again on return.
  const fixBackground = async (which: 'battery' | 'alarms') => {
    const before = background;
    const opened = which === 'battery' ? await requestBatteryExemption() : await openExactAlarmSettings();
    if (!opened) {
      toast({
        title: 'Ayarlar açılamadı',
        body:
          which === 'battery'
            ? 'Ayarlar → Uygulamalar → KOYDUM → Pil yolundan “Kısıtlanmamış”ı seç.'
            : 'Ayarlar → Uygulamalar → Özel uygulama erişimi → Alarmlar ve hatırlatıcılar yolunu kendin dene.',
        kind: 'danger',
      });
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      sub.remove();
      void (async () => {
        const next = await getBackgroundHealth();
        setBackground(next);
        // Alarms set before the grant stay inexact until they are set again, so
        // set them again now. Runs are queued, so this cannot race the bridge's
        // own foreground refresh.
        if (next?.exactAlarms && before && !before.exactAlarms) {
          try {
            await refreshReminders(api, level, tz);
          } catch {
            // offline: the bridge does it on the next foreground
          }
        }
      })();
    });
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
    const softened = reason === 'expo-go-android' || reason === 'no-fcm';
    return {
      label: reason === 'no-fcm' ? 'Gecikmeli' : reason === 'expo-go-android' ? 'Kısıtlı' : 'Kapalı',
      color: softened ? Colors.yellow : Colors.danger,
      detail: push.detail ? `${detail} (${push.detail})` : detail,
    };
  };

  const pushStatus = pushLine();
  const nudgesOn = prefOverride.nudgesEnabled ?? me?.nudgesEnabled ?? true;
  const recapOn = prefOverride.recapEnabled ?? me?.recapEnabled ?? true;

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

      {/* --------------------------------------------------- notifications */}
      <Card>
        <Text variant="label">Bildirim tercihleri</Text>
        <Text variant="body" bold style={styles.blockTop}>
          Günlük hatırlatma
        </Text>
        <Text variant="tiny" muted>
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
        <PrefRow
          title="Geride kalınca dürt beni"
          detail={byLevel(
            level,
            'Bir çelıncta geride kaldığında öğleden sonra bir kez haber veririz.',
            'Biri sana fark atınca öğleden sonra bir kere dürteriz, çelınc başına günde bir tane.',
            'Biri sana fark koyunca öğleden sonra bir kere “o ne lan” deriz 🍆'
          )}
          value={nudgesOn}
          onChange={(on) => choosePref('nudgesEnabled', on)}
        />
        <PrefRow
          title="Pazar akşamı haftalık özet"
          detail={byLevel(
            level,
            'Pazar akşamı haftanın özeti: galibiyetler, mağlubiyetler, adımlar.',
            'Pazar akşamı haftanın hesabı: kaç kere koydun, kaç kere yedin, haftanın kralı kim.',
            'Pazar akşamı haftanın hesabı: kime koydun, kimden yedin, taht kimde 🍆'
          )}
          value={recapOn}
          onChange={(on) => choosePref('recapEnabled', on)}
        />
        {/* the web build schedules nothing, so there is nothing to switch off there */}
        {Platform.OS !== 'web' && deviceAlerts !== null ? (
          <PrefRow
            title="Saatli çelınc uyarıları"
            detail={byLevel(
              level,
              'Check-in saatinden yarım saat önce ve çelınc bitmeden bir saat önce hatırlatır. Sadece bu telefon için.',
              'Check-in saatine yarım saat kala ve çelıncın son saatinde çalar. Sadece bu telefonda.',
              'Check-in’e yarım saat kala ve son saatte “yetiştir yoksa yersin” der. Sadece bu telefonda.'
            )}
            value={deviceAlerts}
            onChange={(on) => void chooseDeviceAlerts(on)}
          />
        ) : null}
        <Text variant="micro" faint style={styles.blockTop}>
          {byLevel(
            level,
            '“KOYDUM MU?” lafları her zaman gelir, onları kapatamazsın. Kankaların dürtmesi, davetler ve sonuçlar da öyle.',
            '“KOYDUM MU?” her zaman gelir, onu kapatamazsın. Kankanın elle dürtmesi, davetler ve sonuçlar da gelir.',
            '“KOYDUM MU?” her zaman gelir, onu kapatamazsın: yediysen duyacaksın 🍆 Kankanın dürtmesi, davetler ve sonuçlar da gelir.'
          )}
        </Text>
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
        <Pressable accessibilityRole="button" onPress={() => setServerOpen(true)}>
          <View style={styles.rowBetween}>
            <View style={styles.rowText}>
              <Text variant="body" bold numberOfLines={1}>
                {serverUrl.replace(/^https?:\/\//, '')}
              </Text>
              <Text variant="tiny" muted>
                Adres değiştiyse dokun, yenisini yaz. Aynı sunucuysa çıkış yok.
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
        <View style={styles.buttonRow}>
          {/* Android stops asking after the second no; from then on only this page can fix it */}
          {push?.reason === 'denied' ? (
            <Button title="Ayarları aç" size="sm" onPress={() => void openPushSettings()} />
          ) : null}
          <Button
            title="Tekrar dene"
            variant="secondary"
            size="sm"
            loading={pushBusy}
            onPress={() => void refreshPush()}
          />
        </View>
      </Card>

      {/* ------------------------------------- background: Android build only */}
      {background ? (
        <Card>
          <Text variant="label">Arka plan</Text>
          <HealthRow
            title="Pil kısıtlaması"
            ok={background.batteryUnrestricted}
            okLabel="Yok"
            offLabel="Var"
            detail={
              background.batteryUnrestricted
                ? 'Telefon KOYDUM’u arka planda uyutmuyor.'
                : 'Uygulama kapalıyken de “KOYDUM MU?” vaktinde gelsin diye pil kısıtlamasını kaldır.'
            }
            action="Kısıtlamayı kaldır"
            onAction={() => void fixBackground('battery')}
          />
          <HealthRow
            title="Tam saatinde hatırlatma"
            ok={background.exactAlarms}
            okLabel="Açık"
            offLabel="Kapalı"
            detail={
              background.exactAlarms
                ? 'Check-in hatırlatmaları tam saatinde çalar.'
                : 'İzin vermezsen telefon check-in hatırlatmasını kaydırabilir, 06:30’daki uyarı 07:00’yi geçebilir.'
            }
            action="Alarm izni ver"
            onAction={() => void fixBackground('alarms')}
          />
          {background.xiaomi ? (
            <Text variant="micro" faint style={styles.blockTop}>
              Xiaomi’de bir de Ayarlar → Uygulamalar → KOYDUM → “Otomatik başlatma”yı aç, yoksa telefon KOYDUM’u
              arka planda hiç uyandırmayabilir.
            </Text>
          ) : null}
        </Card>
      ) : null}

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
                  ? steps.upgrade === 'play-services'
                    ? 'Adımlar şimdilik uygulama açıkken sayılıyor (yaklaşık). Google Play hizmetlerini Play Store’dan güncellersen telefon, uygulama kapalıyken de sayar.'
                    : 'Adımlar uygulama açıkken sayılıyor (yaklaşık). Kesin sonuç için Health Connect kur.'
                  : 'Adımlarını telefon kendisi sayıyor, uygulama kapalıyken de. Günlük toplam kendiliğinden gelir.'
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

      {/* ----------------------------------------------------- screen time */}
      <Card>
        <View style={styles.rowBetween}>
          <Text variant="label">Ekran süresi</Text>
          <Chip
            label={screenTime ? (screenTime.available ? 'Açık' : Platform.OS === 'android' ? 'Kapalı' : 'Elle') : '…'}
            color={
              screenTime
                ? screenTime.available
                  ? Colors.success
                  : Platform.OS === 'android'
                    ? Colors.danger
                    : Colors.textMuted
                : Colors.textMuted
            }
            size="sm"
          />
        </View>
        <Text variant="tiny" muted style={styles.blockTop}>
          {!screenTime
            ? 'Bakıyorum…'
            : screenTime.available
              ? 'Ekran süren telefondan okunuyor. Ekran süresi çelıncında elle giriş yok, uygulama kendisi gönderir.'
              : SCREEN_TIME_REASONS[screenTime.reason] +
                (screenTime.reason === 'error' && screenTime.detail ? ` (${screenTime.detail})` : '')}
        </Text>
        {screenTime && !screenTime.available && screenTime.reason === 'permission' ? (
          <Button
            title="Kullanım erişimi ver"
            variant="secondary"
            size="sm"
            style={styles.selfStart}
            onPress={() => void askScreenTimePermission()}
          />
        ) : null}
      </Card>

      {/* --------------------------------------------------------- blocked */}
      <BlockedCard />

      {/* --------------------------------------------------------- account */}
      <Card>
        <Text variant="label">Hesap</Text>
        <View style={styles.block}>
          <Text variant="tiny" muted>
            {me ? `@${me.username} · davet kodu ${me.inviteCode}` : 'Hesap bilgisi yüklenemedi.'}
          </Text>
          <Button
            title="Şifreni değiştir"
            variant="secondary"
            fullWidth
            onPress={() => setPasswordOpen(true)}
          />
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
        {update ? (
          <>
            <Button
              title={`Yeni sürümü indir (${update.latest})`}
              variant="secondary"
              size="sm"
              style={styles.selfCenter}
              onPress={() => void Linking.openURL(update.downloadUrl)}
            />
            <Text variant="micro" faint center>
              {UPDATE_HOW}
            </Text>
          </>
        ) : null}
        <Text variant="micro" faint center>
          Bu uygulama eğlence ve gelişim için tasarlandı. Amacının dışına çıkarmayın, kimse
          kimseyi kırmasın.
        </Text>
      </View>

      <PasswordSheet visible={passwordOpen} onClose={() => setPasswordOpen(false)} />
      {serverEditable ? <ServerSheet visible={serverOpen} onClose={() => setServerOpen(false)} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.lg },
  selfCenter: { alignSelf: 'center' },
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
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
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
