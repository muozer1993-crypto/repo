import type {
  ChallengeDetail,
  ChallengeType,
  EntrySource,
  FeedItem,
  ParticipantView,
  VulgarityLevel,
} from '@koydum/shared';
import { LIMITS, addDays, getChallengeType, scoreLabel, t } from '@koydum/shared';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Countdown, formatRemaining } from '@/components/Countdown';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { Standings } from '@/components/Standings';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import {
  useAddEntry,
  useChallenge,
  useChallengeAction,
  useDispute,
  usePoke,
} from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { ApiError } from '@/lib/api';
import { useTimezone } from '@/hooks/useTimezone';
import { getDailySteps, getStepAvailability, getTodaySteps, type StepAvailability } from '@/services/steps';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { confirmTr } from '@/utils/confirm';
import { safeDayKeysBetween, safeTodayKey } from '@/utils/datetime';
import { errorText } from '@/utils/errors';
import { formatDayKeyFriendly, formatMinutes, formatNumber, formatTime, relativeTime } from '@/utils/format';

/* ------------------------------------------------------------------ utils */

const SOURCE_ICON: Record<EntrySource, string> = {
  pedometer: '👟',
  health_connect: '❤️',
  manual: '✍️',
  focus: '🎯',
  checkin: '⏰',
};

const SOURCE_LABEL: Record<EntrySource, string> = {
  pedometer: 'sayaç',
  health_connect: 'Health Connect',
  manual: 'beyan',
  focus: 'odak seansı',
  checkin: 'check-in',
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: 'BEKLİYOR', color: Colors.info },
  active: { label: 'AKTİF', color: Colors.success },
  finished: { label: 'BİTTİ', color: Colors.textMuted },
  cancelled: { label: 'İPTAL', color: Colors.danger },
};

/** Uploads come back absolute, but a relative path must still resolve. */
function absoluteUrl(url: string, baseUrl: string): string {
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('file:')) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/** +1 / +5 / +10, scaled down for small caps and up for very generous ones. */
function quickAdds(maxPerEntry: number): number[] {
  const cap = Math.max(1, Math.floor(maxPerEntry));
  const presets = cap >= 400 ? [10, 25, 50] : cap >= 100 ? [5, 10, 25] : [1, 5, 10];
  return presets.filter((value) => value <= cap);
}

function nowIso(): string {
  return new Date().toISOString();
}

/* ----------------------------------------------------------------- screen */

export default function ChallengeDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const level = useLevel();
  const me = useAuth((s) => s.me);
  const meId = me?.id ?? null;
  const tz = useTimezone();
  const serverUrl = useAuth((s) => s.serverUrl);

  const query = useChallenge(id);
  const detail = query.data;
  const type = detail ? getChallengeType(detail.challenge.typeKey) : undefined;

  const [proofUrl, setProofUrl] = useState<string | null>(null);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  // a link without an id leaves the query disabled, which would otherwise
  // render the skeleton below forever
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Çelinç" />
        <EmptyState
          emoji="🫥"
          title="Çelinç bulunamadı"
          subtitle="Bu bağlantıda çelinç numarası yok. Listeden birine dokun."
          actionLabel="Listeye dön"
          onAction={back}
        />
      </Screen>
    );
  }

  if (query.isPending) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Çelinç" />
        <Skeleton height={150} style={styles.block} />
        <Skeleton height={190} style={styles.block} />
        <Skeleton height={120} style={styles.block} />
      </Screen>
    );
  }

  if (query.isError || !detail) {
    const err = query.error;
    const missing = err instanceof ApiError && err.status === 404;
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Çelinç" />
        <EmptyState
          emoji={missing ? '🫥' : '📡'}
          title={missing ? 'Bu çelinç sende yok' : 'Çelinç gelmedi'}
          subtitle={
            missing
              ? 'Ya silindi ya da bu çelincin içinde değilsin.'
              : errorText(err, 'Sunucuya ulaşamadım.')
          }
          actionLabel={missing ? 'Listeye dön' : 'Tekrar dene'}
          onAction={() => (missing ? back() : void query.refetch())}
        />
      </Screen>
    );
  }

  const { challenge, participants } = detail;
  const mine = detail.me;
  const status = STATUS_META[challenge.status] ?? STATUS_META.pending;
  const accepted = participants.filter((p) => p.status === 'accepted');
  const dayKeys = safeDayKeysBetween(challenge.startsAt, challenge.endsAt, tz);
  const today = safeTodayKey(tz);
  const yesterday = addDays(today, -1);
  const isPlayer = mine?.status === 'accepted';
  const leading = (mine?.rank ?? 0) === 1;

  return (
    <Screen
      scroll
      glow
      onRefresh={() => void query.refetch()}
      refreshing={query.isRefetching}
      contentStyle={styles.content}
      bottomInset={Spacing.xxl}>
      <Header onBack={back} title={type?.nameTr ?? 'Çelinç'} />

      {/* --------------------------------------------------------- hero */}
      <Card glow={challenge.status === 'active'} edgeColor={status.color}>
        <View style={styles.heroTop}>
          <Text style={styles.heroEmoji}>{type?.emoji ?? '🎯'}</Text>
          <View style={styles.heroBody}>
            <Text variant="title" numberOfLines={2}>
              {challenge.title || type?.nameTr || 'Çelinç'}
            </Text>
            <Text variant="tiny" muted numberOfLines={1}>
              {accepted.length} kişi · {type?.unitTr ?? ''}
            </Text>
          </View>
          <Chip label={status.label} color={status.color} size="sm" filled={challenge.status === 'active'} />
        </View>

        <View style={styles.heroClock}>
          {challenge.status === 'pending' ? (
            <>
              <Text variant="label">Başlamasına</Text>
              <Countdown target={challenge.startsAt} variant="big" finishedLabel="Başlıyor" />
            </>
          ) : challenge.status === 'active' ? (
            <>
              <Text variant="label">Bitmesine</Text>
              <Countdown
                target={challenge.endsAt}
                variant="big"
                finishedLabel="Süre doldu"
                onFinish={() => void query.refetch()}
              />
            </>
          ) : (
            <>
              <Text variant="label">Kapandı</Text>
              <Text variant="big">
                {relativeTime(challenge.finalizedAt ?? challenge.endsAt) || 'Bitti'}
              </Text>
            </>
          )}
          {challenge.deadlineTime ? (
            <Text variant="tiny" faint>
              Günlük saat sınırı: {challenge.deadlineTime}
            </Text>
          ) : null}
        </View>

        {challenge.rewardText || challenge.penaltyText ? (
          <View style={styles.prizes}>
            {challenge.rewardText ? (
              <Text variant="small">
                🎁 <Text variant="small" bold>{challenge.rewardText}</Text>
              </Text>
            ) : null}
            {challenge.penaltyText ? (
              <Text variant="small" color={Colors.danger}>
                💀 {challenge.penaltyText}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Card>

      {/* ---------------------------------------------------- standings */}
      <Card>
        <Text variant="label" style={styles.sectionLabel}>
          Sıralama
        </Text>
        <Standings participants={participants} type={type} meId={meId} finished={challenge.status === 'finished'} />
        {challenge.status === 'active' && isPlayer ? (
          <Text
            variant="small"
            bold
            color={leading ? Colors.success : Colors.accent}
            style={styles.verdict}>
            {t(leading ? 'challenge_active_leading' : 'challenge_active_losing', level)}
          </Text>
        ) : null}
        {challenge.status === 'pending' && mine?.status === 'invited' ? (
          <Text variant="small" muted style={styles.verdict}>
            {t('challenge_pending_you', level)}
          </Text>
        ) : null}
      </Card>

      {/* -------------------------------------------------- invite reply */}
      {mine?.status === 'invited' && (challenge.status === 'pending' || challenge.status === 'active') ? (
        <InviteActions id={id} />
      ) : null}

      {/* ------------------------------------------------------- actions */}
      {challenge.status === 'active' && isPlayer && type ? (
        <ActionArea
          id={id}
          detail={detail}
          type={type}
          level={level}
          today={today}
          yesterday={yesterday}
          dayKeys={dayKeys}
        />
      ) : null}

      {/* ---------------------------------------------------------- feed */}
      <Feed
        detail={detail}
        type={type}
        meId={meId}
        today={today}
        yesterday={yesterday}
        level={level}
        baseUrl={serverUrl}
        challengeId={id}
        onProof={setProofUrl}
      />

      {/* --------------------------------------------------------- pokes */}
      {challenge.status === 'active' && isPlayer && detail.canPoke !== false ? (
        <PokeSection id={id} rivals={accepted.filter((p) => p.user.id !== meId)} level={level} />
      ) : null}

      {/* -------------------------------------------------------- footer */}
      <FooterActions
        id={id}
        detail={detail}
        meId={meId}
        onLeft={back}
      />

      <Sheet visible={!!proofUrl} onClose={() => setProofUrl(null)} title="Kanıt" scroll={false}>
        {proofUrl ? (
          <Image
            source={{ uri: absoluteUrl(proofUrl, serverUrl) }}
            style={styles.proofFull}
            contentFit="contain"
            transition={120}
          />
        ) : null}
        <Button title="Kapat" variant="secondary" fullWidth onPress={() => setProofUrl(null)} />
      </Sheet>
    </Screen>
  );
}

/* ----------------------------------------------------------------- header */

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Geri" onPress={onBack} style={styles.backBtn}>
        <Text variant="title">‹</Text>
      </Pressable>
      <Text variant="label" numberOfLines={1} style={styles.headerTitle}>
        {title}
      </Text>
    </View>
  );
}

/* --------------------------------------------------------- invite actions */

function InviteActions({ id }: { id: string }) {
  const action = useChallengeAction(id);
  const toast = useToast();

  const run = async (kind: 'accept' | 'decline') => {
    try {
      await action.mutateAsync(kind);
      toast({
        title: kind === 'accept' ? 'Girdin' : 'Kaçtın',
        body: kind === 'accept' ? 'Skorun sayılmaya başladı.' : 'Bu çelinç sensiz devam ediyor.',
        kind: kind === 'accept' ? 'success' : 'info',
      });
    } catch (error) {
      toast({ title: 'Olmadı', body: errorText(error, 'İşlem yapılamadı.'), kind: 'danger' });
    }
  };

  return (
    <Card edgeColor={Colors.yellow}>
      <Text variant="lead">Davet sende</Text>
      <View style={styles.row}>
        <Button
          title="Varım"
          size="md"
          style={styles.grow}
          loading={action.isPending}
          onPress={() => void run('accept')}
        />
        <Button
          title="Yokum"
          variant="ghost"
          size="md"
          style={styles.grow}
          disabled={action.isPending}
          onPress={() => void run('decline')}
        />
      </View>
    </Card>
  );
}

/* ------------------------------------------------------------ action area */

interface ActionProps {
  id: string;
  detail: ChallengeDetail;
  type: ChallengeType;
  level: VulgarityLevel;
  today: string;
  yesterday: string;
  dayKeys: string[];
}

function ActionArea(props: ActionProps) {
  const { type } = props;
  return (
    <Card edgeColor={Colors.accent}>
      <Text variant="label" style={styles.sectionLabel}>
        Senin sıran
      </Text>
      {type.metricType === 'auto_steps' ? <StepsAction {...props} /> : null}
      {type.metricType === 'focus_minutes' ? <FocusAction {...props} /> : null}
      {type.metricType === 'checkin_deadline' ? <CheckinAction {...props} /> : null}
      {type.metricType === 'daily_boolean' ? <BooleanAction {...props} /> : null}
      {type.metricType === 'manual_count' ? <CountAction {...props} /> : null}
      {type.metricType === 'manual_lower_is_better' ? <LowerAction {...props} /> : null}
    </Card>
  );
}

function openEntryModal(id: string, dayKey: string, proof?: boolean) {
  router.push({
    pathname: '/challenge/[id]/entry',
    params: { id, day: dayKey, proof: proof ? '1' : '0' },
  });
}

/* auto_steps ------------------------------------------------------------- */

function StepsAction({ id, detail, type, today }: ActionProps) {
  const api = useApi();
  const toast = useToast();
  const query = useChallenge(id);
  const [availability, setAvailability] = useState<StepAvailability | null>(null);
  const [deviceSteps, setDeviceSteps] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await getStepAvailability();
        if (!alive) return;
        setAvailability(next);
        const value = next.available ? await getTodaySteps() : null;
        if (alive) setDeviceSteps(value);
      } catch {
        if (alive) setAvailability({ available: false, reason: 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const recorded = detail.myEntries.find((entry) => entry.dayKey === today);
  const approximate = availability?.available === true && availability.approximate;
  const unavailable = availability !== null && !availability.available;

  const sync = async () => {
    setSyncing(true);
    try {
      const days = await getDailySteps(LIMITS.STEPS_BACKFILL_DAYS);
      if (days.length === 0) {
        toast({
          title: 'Sayacak adım yok',
          body: 'Telefon henüz adım vermedi. Biraz yürü, sonra tekrar dene.',
          kind: 'info',
        });
        return;
      }
      const result = await api.syncSteps(days);
      await query.refetch();
      toast({
        title: 'Adımlar gitti',
        body: `${formatNumber(result.updated)} gün güncellendi.`,
        kind: 'success',
      });
    } catch (error) {
      toast({ title: 'Senkron olmadı', body: errorText(error, 'Adımlar gönderilemedi.'), kind: 'danger' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <View style={styles.actionBody}>
      <View style={styles.bigValueRow}>
        <Text variant="huge" numberOfLines={1} adjustsFontSizeToFit>
          {formatNumber(recorded?.value ?? deviceSteps ?? 0)}
        </Text>
        <Text variant="small" muted style={styles.bigValueUnit}>
          {type.unitTr} · bugün
        </Text>
      </View>

      {recorded && deviceSteps !== null && deviceSteps !== recorded.value ? (
        <Text variant="tiny" faint>
          Telefon {formatNumber(deviceSteps)} diyor, sunucuda {formatNumber(recorded.value)} yazıyor. Senkronla.
        </Text>
      ) : null}

      <View style={styles.row}>
        {!unavailable ? (
          <Button
            title="Senkronla"
            icon="🔄"
            size="md"
            style={styles.grow}
            loading={syncing}
            disabled={availability === null}
            onPress={() => void sync()}
          />
        ) : null}
        {approximate || unavailable ? (
          <Button
            title="Beyan et"
            icon="✍️"
            variant={availability?.available ? 'secondary' : 'primary'}
            size="md"
            style={styles.grow}
            onPress={() => openEntryModal(id, today)}
          />
        ) : null}
      </View>

      {approximate ? (
        <Text variant="tiny" faint>
          Yaklaşık (uygulama açıkken sayılıyor). Sayaç eksik kalırsa değeri elle beyan et.
        </Text>
      ) : null}
      {unavailable ? (
        <Text variant="tiny" faint>
          {stepsReason(availability)} Skorun sıfır kalmasın diye günlük adımını elle beyan edebilirsin.
        </Text>
      ) : null}
    </View>
  );
}

function stepsReason(availability: StepAvailability | null): string {
  if (!availability || availability.available) return '';
  switch (availability.reason) {
    case 'web':
      return 'Adımlar telefondan sayılıyor; tarayıcıda sayaç yok.';
    case 'no-sensor':
      return 'Bu cihazda adım sensörü yok.';
    case 'denied':
      return 'Adım izni verilmedi.';
    case 'health-connect-missing':
      return 'Health Connect kurulu değil.';
    default:
      return availability.detail ?? 'Adımlar okunamadı.';
  }
}

/* focus_minutes ---------------------------------------------------------- */

function FocusAction({ id, detail, level, today }: ActionProps) {
  const todayMinutes = detail.myEntries
    .filter((entry) => entry.dayKey === today && entry.status !== 'rejected')
    .reduce((sum, entry) => sum + entry.value, 0);

  return (
    <View style={styles.actionBody}>
      <View style={styles.bigValueRow}>
        <Text variant="huge" numberOfLines={1} adjustsFontSizeToFit>
          {formatMinutes(todayMinutes)}
        </Text>
        <Text variant="small" muted style={styles.bigValueUnit}>
          bugün odak
        </Text>
      </View>
      <Text variant="tiny" faint>
        {t('focus_start', level)}
      </Text>
      <Button
        title="Odak seansı başlat"
        icon="🎯"
        size="lg"
        fullWidth
        onPress={() => router.push({ pathname: '/focus/[id]', params: { id } })}
      />
    </View>
  );
}

/* checkin_deadline ------------------------------------------------------- */

function CheckinAction({ id, detail, level, today }: ActionProps) {
  const addEntry = useAddEntry(id);
  const toast = useToast();
  const [result, setResult] = useState<'ok' | 'late' | null>(null);

  const entry = detail.myEntries.find((e) => e.dayKey === today);
  const done = !!entry;
  const deadline = detail.challenge.deadlineTime;

  const checkIn = async () => {
    try {
      const response = await addEntry.mutateAsync({
        dayKey: today,
        value: 1,
        source: 'checkin',
        clientTime: nowIso(),
      });
      const late = response.entry.late === true || response.entry.value <= 0;
      setResult(late ? 'late' : 'ok');
      toast({
        title: late ? 'Geç kaldın' : 'Geldin!',
        body: t(late ? 'checkin_late' : 'checkin_ok', level),
        kind: late ? 'danger' : 'success',
      });
    } catch (error) {
      toast({ title: 'Check-in olmadı', body: errorText(error, 'Kaydedilemedi.'), kind: 'danger' });
    }
  };

  const shown = result ?? (done ? (entry && entry.value > 0 ? 'ok' : 'late') : null);

  return (
    <View style={styles.actionBody}>
      {deadline ? (
        <Text variant="small" muted>
          Bugünün sınırı: <Text variant="small" bold>{deadline}</Text>
        </Text>
      ) : null}
      <Button
        title={done ? 'Bugün geldin ✅' : 'Geldim'}
        size="xl"
        fullWidth
        variant={done ? 'secondary' : 'primary'}
        loading={addEntry.isPending}
        disabled={done}
        onPress={() => void checkIn()}
      />
      {shown ? (
        <Text variant="small" color={shown === 'late' ? Colors.danger : Colors.success}>
          {t(shown === 'late' ? 'checkin_late' : 'checkin_ok', level)}
        </Text>
      ) : (
        <Text variant="tiny" faint>
          Check-in sadece bugün için sayılır. Yarın yeniden basacaksın.
        </Text>
      )}
      {entry ? (
        <Text variant="tiny" faint>
          Kayıt saati: {formatTime(entry.createdAt)}
        </Text>
      ) : null}
    </View>
  );
}

/* daily_boolean ---------------------------------------------------------- */

function BooleanAction({ id, detail, today, yesterday, dayKeys }: ActionProps) {
  const addEntry = useAddEntry(id);
  const toast = useToast();
  const [busyDay, setBusyDay] = useState<string | null>(null);

  const entryFor = (dayKey: string) => detail.myEntries.find((e) => e.dayKey === dayKey);
  const todayEntry = entryFor(today);
  const yesterdayEntry = entryFor(yesterday);
  const yesterdayInside = dayKeys.includes(yesterday);

  const send = async (dayKey: string, value: 0 | 1) => {
    setBusyDay(dayKey);
    try {
      await addEntry.mutateAsync({ dayKey, value, source: 'manual', clientTime: nowIso() });
      toast({
        title: value === 1 ? 'Yaptın' : 'Yapmadın',
        body: value === 1 ? 'Gün senin lehine yazıldı.' : 'Dürüstlük de bir erdem, hadi yarın.',
        kind: value === 1 ? 'success' : 'info',
      });
    } catch (error) {
      toast({ title: 'Kaydedilemedi', body: errorText(error, 'Giriş gitmedi.'), kind: 'danger' });
    } finally {
      setBusyDay(null);
    }
  };

  return (
    <View style={styles.actionBody}>
      <BooleanRow
        label="Bugün"
        value={todayEntry?.value}
        busy={busyDay === today}
        onYes={() => void send(today, 1)}
        onNo={() => void send(today, 0)}
      />
      {yesterdayInside && !yesterdayEntry ? (
        <BooleanRow
          label="Dün (boş kalmış)"
          value={undefined}
          busy={busyDay === yesterday}
          onYes={() => void send(yesterday, 1)}
          onNo={() => void send(yesterday, 0)}
        />
      ) : null}
    </View>
  );
}

function BooleanRow({
  label,
  value,
  busy,
  onYes,
  onNo,
}: {
  label: string;
  value: number | undefined;
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  const done = value !== undefined;
  return (
    <View style={styles.boolBlock}>
      <View style={styles.boolHeader}>
        <Text variant="label">{label}</Text>
        {done ? (
          <Chip
            label={value === 1 ? 'YAPTIM' : 'YAPMADIM'}
            color={value === 1 ? Colors.success : Colors.danger}
            size="sm"
            filled
          />
        ) : null}
      </View>
      <View style={styles.row}>
        <Button
          title="Yaptım ✅"
          size="md"
          style={styles.grow}
          variant={value === 1 ? 'success' : 'primary'}
          loading={busy}
          onPress={onYes}
        />
        <Button
          title="Yapmadım ❌"
          size="md"
          style={styles.grow}
          variant={value === 0 ? 'danger' : 'secondary'}
          disabled={busy}
          onPress={onNo}
        />
      </View>
    </View>
  );
}

/* manual_count ----------------------------------------------------------- */

function CountAction({ id, detail, type, today }: ActionProps) {
  const addEntry = useAddEntry(id);
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  const todayTotal = detail.myEntries
    .filter((entry) => entry.dayKey === today && entry.status !== 'rejected')
    .reduce((sum, entry) => sum + entry.value, 0);
  const remaining = Math.max(0, type.maxPerDay - todayTotal);
  const chips = quickAdds(type.maxPerEntry);

  const add = async (value: number) => {
    setBusy(value);
    try {
      await addEntry.mutateAsync({ dayKey: today, value, source: 'manual', clientTime: nowIso() });
      toast({ title: `+${formatNumber(value)} ${type.unitTr}`, body: 'Yazıldı.', kind: 'success' });
    } catch (error) {
      toast({ title: 'Giriş gitmedi', body: errorText(error, 'Kaydedilemedi.'), kind: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.actionBody}>
      <View style={styles.bigValueRow}>
        <Text variant="huge" numberOfLines={1} adjustsFontSizeToFit>
          {formatNumber(todayTotal)}
        </Text>
        <Text variant="small" muted style={styles.bigValueUnit}>
          {type.unitTr} · bugün
        </Text>
      </View>

      {type.proofRequired || detail.challenge.proofRequired ? (
        <Text variant="tiny" faint>
          Bu çelinçte kanıt fotoğrafı isteniyor; hızlı ekleme yerine "+ Giriş" kullan.
        </Text>
      ) : (
        <View style={styles.chipRow}>
          {chips.map((value) => {
            const blocked = value > remaining;
            return (
              <Chip
                key={value}
                label={`+${formatNumber(value)}`}
                color={blocked ? Colors.textFaint : Colors.yellow}
                onPress={blocked || busy !== null ? undefined : () => void add(value)}
              />
            );
          })}
          {remaining <= 0 ? (
            <Text variant="tiny" faint>
              Günlük tavan doldu ({formatNumber(type.maxPerDay)} {type.unitTr}).
            </Text>
          ) : null}
        </View>
      )}

      <Button
        title="+ Giriş"
        size="lg"
        fullWidth
        disabled={busy !== null}
        onPress={() => openEntryModal(id, today)}
      />
      <Text variant="tiny" faint>
        Tek girişte en fazla {formatNumber(type.maxPerEntry)} {type.unitTr}, günde {formatNumber(type.maxPerDay)}{' '}
        {type.unitTr}.
      </Text>
    </View>
  );
}

/* manual_lower_is_better ------------------------------------------------- */

function LowerAction({ id, detail, type, level, today }: ActionProps) {
  const entry = detail.myEntries.find((e) => e.dayKey === today);
  return (
    <View style={styles.actionBody}>
      <View style={styles.bigValueRow}>
        <Text variant="huge" numberOfLines={1} adjustsFontSizeToFit>
          {entry ? formatNumber(entry.value) : '—'}
        </Text>
        <Text variant="small" muted style={styles.bigValueUnit}>
          {type.unitTr} · bugün
        </Text>
      </View>
      <Text variant="tiny" faint>
        Az olan kazanır. Girilmeyen gün {formatNumber(type.missingDayPenalty ?? type.maxPerDay)} {type.unitTr} sayılır,
        yani hiç girmemek en kötüsü.
      </Text>
      <Text variant="tiny" color={Colors.yellow}>
        📸 {t('proof_needed', level)}
      </Text>
      <Button
        title={entry ? 'Bugünkü değeri düzelt' : 'Bugünkü değeri gir'}
        size="lg"
        fullWidth
        onPress={() => openEntryModal(id, today, true)}
      />
    </View>
  );
}

/* ------------------------------------------------------------------- feed */

function Feed({
  detail,
  type,
  meId,
  today,
  yesterday,
  level,
  baseUrl,
  challengeId,
  onProof,
}: {
  detail: ChallengeDetail;
  type: ChallengeType | undefined;
  meId: string | null;
  today: string;
  yesterday: string;
  level: VulgarityLevel;
  baseUrl: string;
  challengeId: string;
  onProof: (url: string) => void;
}) {
  const dispute = useDispute(challengeId);
  const toast = useToast();
  const [target, setTarget] = useState<FeedItem | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const myDisputes = new Set(
    detail.disputes.filter((d) => d.byUserId === meId).map((d) => d.entryId)
  );

  const submit = async () => {
    if (!target) return;
    const text = reason.trim();
    if (text.length < 3) {
      setError('Sebebini iki kelimeyle de olsa yaz.');
      return;
    }
    try {
      await dispute.mutateAsync({ entryId: target.id, reason: text });
      toast({ title: 'İtiraz gitti', body: 'Kankalar bakacak.', kind: 'info' });
      setTarget(null);
      setReason('');
      setError(null);
    } catch (err) {
      setError(errorText(err, 'İtiraz gönderilemedi.'));
    }
  };

  return (
    <Card>
      <Text variant="label" style={styles.sectionLabel}>
        Son girişler
      </Text>

      {detail.feed.length === 0 ? (
        <Text variant="small" faint>
          Henüz giriş yok. İlk yazan sen ol.
        </Text>
      ) : (
        <View style={styles.feedList}>
          {detail.feed.map((item) => (
            <FeedRow
              key={item.id}
              item={item}
              type={type}
              isMine={item.userId === meId}
              alreadyDisputed={myDisputes.has(item.id)}
              today={today}
              yesterday={yesterday}
              level={level}
              baseUrl={baseUrl}
              onProof={onProof}
              onDispute={() => {
                setTarget(item);
                setReason('');
                setError(null);
              }}
            />
          ))}
        </View>
      )}

      <Sheet visible={!!target} onClose={() => setTarget(null)} title={t('dispute_button', level)}>
        <Text variant="small" muted>
          {target ? `${target.displayName} · ${formatDayKeyFriendly(target.dayKey, today, yesterday)} · ` : ''}
          {target && type ? scoreLabel(type, target.value) : ''}
        </Text>
        <Input
          label="Neden yalan?"
          placeholder="O saatte bizimleydi, yürümedi..."
          value={reason}
          onChangeText={(text) => {
            setReason(text);
            setError(null);
          }}
          multiline
          maxLength={LIMITS.DISPUTE_REASON_MAX}
          error={error}
          hint={`${reason.length}/${LIMITS.DISPUTE_REASON_MAX}`}
        />
        <Button
          title="İtirazı gönder"
          fullWidth
          loading={dispute.isPending}
          onPress={() => void submit()}
        />
        <Button title="Vazgeç" variant="ghost" fullWidth onPress={() => setTarget(null)} />
      </Sheet>
    </Card>
  );
}

function FeedRow({
  item,
  type,
  isMine,
  alreadyDisputed,
  today,
  yesterday,
  level,
  baseUrl,
  onProof,
  onDispute,
}: {
  item: FeedItem;
  type: ChallengeType | undefined;
  isMine: boolean;
  alreadyDisputed: boolean;
  today: string;
  yesterday: string;
  level: VulgarityLevel;
  baseUrl: string;
  onProof: (url: string) => void;
  onDispute: () => void;
}) {
  const rejected = item.status === 'rejected';
  const disputed = item.status === 'disputed';

  return (
    <View style={styles.feedRow}>
      {item.proofUrl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Kanıtı büyüt"
          onPress={() => onProof(item.proofUrl as string)}>
          <Image
            source={{ uri: absoluteUrl(item.proofUrl, baseUrl) }}
            style={styles.thumb}
            contentFit="cover"
            transition={120}
          />
        </Pressable>
      ) : (
        <View style={styles.thumbPlaceholder}>
          <Text style={styles.thumbEmoji}>{SOURCE_ICON[item.source] ?? '•'}</Text>
        </View>
      )}

      <View style={styles.feedBody}>
        <View style={styles.feedLine}>
          <Text variant="small" bold numberOfLines={1} style={styles.feedName}>
            {item.displayName}
            {isMine ? ' (sen)' : ''}
          </Text>
          <Text
            variant="small"
            bold
            color={rejected ? Colors.textFaint : Colors.text}
            style={rejected ? styles.struck : undefined}
            numberOfLines={1}>
            {type ? scoreLabel(type, item.value) : formatNumber(item.value)}
          </Text>
        </View>
        <Text variant="tiny" faint numberOfLines={1}>
          {formatDayKeyFriendly(item.dayKey, today, yesterday)} · {SOURCE_ICON[item.source] ?? '•'}{' '}
          {SOURCE_LABEL[item.source] ?? item.source} · {relativeTime(item.createdAt)}
        </Text>
        {rejected ? (
          <Text variant="tiny" color={Colors.danger}>
            İptal edildi, skora sayılmıyor.
          </Text>
        ) : disputed ? (
          <Text variant="tiny" color={Colors.yellow}>
            İtiraz var, bakılıyor.
          </Text>
        ) : null}
      </View>

      {!isMine && !rejected ? (
        <Chip
          label={alreadyDisputed ? 'İtiraz ettin' : t('dispute_button', level)}
          color={alreadyDisputed ? Colors.textFaint : Colors.danger}
          size="sm"
          onPress={alreadyDisputed ? undefined : onDispute}
        />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ pokes */

function PokeSection({
  id,
  rivals,
  level,
}: {
  id: string;
  rivals: ParticipantView[];
  level: VulgarityLevel;
}) {
  const poke = usePoke(id);
  const toast = useToast();
  const [blocked, setBlocked] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // keep the "x dk sonra" note honest while the screen stays open
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (rivals.length === 0) return null;

  const send = async (userId: string, name: string) => {
    setPending(userId);
    try {
      await poke.mutateAsync({ toUserId: userId });
      setBlocked((prev) => ({ ...prev, [userId]: Date.now() + LIMITS.POKE_COOLDOWN_MS }));
      toast({ title: 'Dürttün', body: `${name} şu an titredi.`, kind: 'taunt' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'poke_cooldown') {
        setBlocked((prev) => ({ ...prev, [userId]: Date.now() + LIMITS.POKE_COOLDOWN_MS }));
        toast({ title: 'Çok sık oldu', body: error.message, kind: 'info' });
      } else {
        toast({ title: 'Dürtemedim', body: errorText(error, 'Gönderilemedi.'), kind: 'danger' });
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <Text variant="label" style={styles.sectionLabel}>
        Dürt
      </Text>
      <View style={styles.pokeList}>
        {rivals.map((rival) => {
          const until = blocked[rival.user.id] ?? 0;
          const cooling = until > Date.now();
          return (
            <View key={rival.user.id} style={styles.pokeRow}>
              <Avatar emoji={rival.user.avatarEmoji} name={rival.user.displayName} size={34} />
              <View style={styles.pokeBody}>
                <Text variant="small" bold numberOfLines={1}>
                  {rival.user.displayName}
                </Text>
                <Text variant="tiny" faint numberOfLines={1}>
                  {cooling
                    ? `2 saat dolmadan tekrar dürtemezsin (${formatRemaining(until - Date.now())})`
                    : `${rival.rank}. sırada`}
                </Text>
              </View>
              <Button
                title={t('poke_button', level)}
                size="sm"
                variant={cooling ? 'ghost' : 'secondary'}
                disabled={cooling}
                loading={pending === rival.user.id}
                onPress={() => void send(rival.user.id, rival.user.displayName)}
              />
            </View>
          );
        })}
      </View>
    </Card>
  );
}

/* ----------------------------------------------------------------- footer */

function FooterActions({
  id,
  detail,
  meId,
  onLeft,
}: {
  id: string;
  detail: ChallengeDetail;
  meId: string | null;
  onLeft: () => void;
}) {
  const action = useChallengeAction(id);
  const toast = useToast();
  const { challenge, me: mine } = detail;

  const canLeave =
    (challenge.status === 'pending' || challenge.status === 'active') &&
    (mine?.status === 'accepted' || mine?.status === 'invited');
  const canCancel = challenge.status === 'pending' && challenge.creatorId === meId;
  const finished = challenge.status === 'finished';

  const run = async (kind: 'leave' | 'cancel') => {
    const ok = await confirmTr(
      kind === 'leave' ? 'Ayrılıyor musun?' : 'Çelinci iptal et',
      kind === 'leave'
        ? 'Skorun silinmez ama sıralamadan düşersin. Kankalar bunu görecek.'
        : 'Herkese iptal bildirimi gider. Emin misin?',
      kind === 'leave' ? 'Ayrıl' : 'İptal et'
    );
    if (!ok) return;
    try {
      await action.mutateAsync(kind);
      toast({
        title: kind === 'leave' ? 'Ayrıldın' : 'İptal edildi',
        body: kind === 'leave' ? 'Bu çelinç sensiz devam ediyor.' : 'Çelinç kapandı.',
        kind: 'info',
      });
      onLeft();
    } catch (error) {
      toast({ title: 'Olmadı', body: errorText(error, 'İşlem yapılamadı.'), kind: 'danger' });
    }
  };

  if (!canLeave && !canCancel && !finished) return null;

  return (
    <View style={styles.footer}>
      {finished ? (
        <Button
          title="Sonuçları gör"
          icon="🏆"
          size="xl"
          fullWidth
          onPress={() => router.push({ pathname: '/challenge/[id]/results', params: { id } })}
        />
      ) : null}
      {canCancel ? (
        <Button
          title="İptal et"
          variant="danger"
          size="md"
          fullWidth
          loading={action.isPending}
          onPress={() => void run('cancel')}
        />
      ) : null}
      {canLeave ? (
        <Button
          title="Ayrıl"
          variant="ghost"
          size="md"
          fullWidth
          disabled={action.isPending}
          onPress={() => void run('leave')}
        />
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.md },
  block: { borderRadius: Radius.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  headerTitle: { flex: 1 },

  heroTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  heroEmoji: { fontSize: 38 },
  heroBody: { flex: 1, gap: 2 },
  heroClock: { marginTop: Spacing.lg, gap: 2 },
  prizes: { marginTop: Spacing.md, gap: 4 },

  sectionLabel: { marginBottom: Spacing.md },
  verdict: { marginTop: Spacing.md },

  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  grow: { flex: 1 },

  actionBody: { gap: Spacing.md },
  bigValueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm },
  bigValueUnit: { marginBottom: 6 },
  chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: Spacing.sm },
  boolBlock: { gap: Spacing.sm },
  boolHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  feedList: { gap: Spacing.lg },
  feedRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  feedBody: { flex: 1, gap: 2 },
  feedLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  feedName: { flexShrink: 1 },
  struck: { textDecorationLine: 'line-through' },
  thumb: { width: 44, height: 44, borderRadius: Radius.sm, backgroundColor: Colors.surfaceHigh },
  thumbPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: Radius.sm,
    backgroundColor: Colors.surfaceHigh,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbEmoji: { fontSize: 18 },
  proofFull: { width: '100%', height: 380, borderRadius: Radius.md, backgroundColor: Colors.surfaceHigh },

  pokeList: { gap: Spacing.md },
  pokeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pokeBody: { flex: 1, gap: 2 },

  footer: { gap: Spacing.sm, marginTop: Spacing.sm },
});
