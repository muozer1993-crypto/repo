import type {
  Challenge,
  ChallengeDetail,
  ChallengeType,
  Dispute,
  DisputeStatus,
  EntrySource,
  FeedItem,
  ParticipantView,
  TauntVars,
  VulgarityLevel,
} from '@koydum/shared';
import {
  LIMITS,
  addDays,
  formatNumberTr,
  getChallengeType,
  renderTaunt,
  scoreLabel,
  t,
  tauntsAtLevel,
} from '@koydum/shared';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform, Pressable, StyleSheet, View } from 'react-native';

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
  useAddEntryProof,
  useChallenge,
  useChallengeAction,
  useDeleteEntry,
  useDispute,
  usePoke,
  useWithdrawDispute,
} from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { useProofPhoto } from '@/hooks/useProofPhoto';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useTimezone } from '@/hooks/useTimezone';
import {
  getScreenTimeAvailability,
  getTodayScreenMinutes,
  requestScreenTimePermission,
  type ScreenTimeAvailability,
} from '@/services/screenTime';
import { syncScreenTimeNow } from '@/services/screenTimeSync';
import { getStepAvailability, getTodaySteps, type StepAvailability } from '@/services/steps';
import { syncStepsNow } from '@/services/stepSync';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { byLevel, declineQuestion, endsWithoutMe } from '@/utils/levelCopy';
import { confirmTr } from '@/utils/confirm';
import { safeDayKeysBetween, safeTodayKey } from '@/utils/datetime';
import { errorText } from '@/utils/errors';
import { formatDayKeyFriendly, formatMinutes, formatNumber, formatTime, relativeTime } from '@/utils/format';
import { uuidV4 } from '@/utils/ids';
import { resolveServerUrl } from '@/utils/url';

/* ------------------------------------------------------------------ utils */

const SOURCE_ICON: Record<EntrySource, string> = {
  pedometer: '👟',
  health_connect: '❤️',
  manual: '✍️',
  focus: '🎯',
  checkin: '⏰',
  usage_stats: '📱',
};

const SOURCE_LABEL: Record<EntrySource, string> = {
  pedometer: 'sayaç',
  health_connect: 'Health Connect',
  manual: 'beyan',
  focus: 'odak seansı',
  checkin: 'check-in',
  usage_stats: 'telefon okudu',
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: 'BEKLİYOR', color: Colors.info },
  active: { label: 'AKTİF', color: Colors.success },
  finished: { label: 'BİTTİ', color: Colors.textMuted },
  cancelled: { label: 'İPTAL', color: Colors.danger },
};

/** +1 / +5 / +10, scaled down for small caps and up for very generous ones. */
function quickAdds(maxPerEntry: number): number[] {
  const cap = Math.max(1, Math.floor(maxPerEntry));
  const presets = cap >= 400 ? [10, 25, 50] : cap >= 100 ? [5, 10, 25] : [1, 5, 10];
  return presets.filter((value) => value <= cap);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * What the server is still waiting for once the time is up (`settling`). An
 * itiraz inside its answer window holds the result longer than any phone.
 */
function settlingNote(type: ChallengeType | undefined, awaitingProof: boolean): string {
  if (awaitingProof) {
    return 'Bir girişe itiraz var, sahibinin fotoğraf eklemesi bekleniyor. Kanıt gelince ya da süresi dolunca kazanan belli olur.';
  }
  switch (type?.deviceMetric) {
    case 'steps':
      return 'Telefonların saydığı son adımlar toplanıyor. Herkesinki gelince, en fazla da bir saat içinde kazanan belli olur.';
    case 'screen_time':
      return 'Telefonların ölçtüğü son ekran süreleri toplanıyor. Herkesinki gelince, en fazla da bir saat içinde kazanan belli olur.';
    default:
      return 'Son hesap yapılıyor, bir dakikaya kalmaz.';
  }
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

  const api = useApi();
  const queryClient = useQueryClient();
  const refreshMe = useAuth((s) => s.refreshMe);

  const [proofUrl, setProofUrl] = useState<string | null>(null);
  // Read on mount (and again when the end countdown runs out) instead of during
  // render: `Date.now()` in render is impure for the React Compiler. The query
  // refetches every 45 s, so a start time that passes while the screen is open
  // is still picked up.
  const [renderedAt, setRenderedAt] = useState(() => Date.now());

  /**
   * Past its end, a çelınc the phones count stays `active` for up to an hour on
   * the server while it waits for the last evening's sync, and typed entries are
   * refused from the end on. The screen says "sonuç birazdan" instead of a
   * countdown stuck at zero and offers no entry buttons.
   */
  const endsAtMs = detail ? Date.parse(detail.challenge.endsAt) : Number.NaN;
  const settling = detail?.challenge.status === 'active' && Number.isFinite(endsAtMs) && endsAtMs <= renderedAt;
  const settlingMetric = settling && detail?.me?.status === 'accepted' ? type?.deviceMetric : undefined;

  // The background sync may be 15+ minutes away; somebody looking at the result
  // is the moment to send this phone's last count, so it is not the one missing.
  useEffect(() => {
    if (!settlingMetric) return;
    const sync = settlingMetric === 'steps' ? syncStepsNow : syncScreenTimeNow;
    sync({ client: api, queryClient, refreshMe }).catch(() => {
      // best effort: the app sends it again on the next foreground or background run
    });
  }, [settlingMetric, api, queryClient, refreshMe]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  // a link without an id leaves the query disabled, which would otherwise
  // render the skeleton below forever
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Çelınc" />
        <EmptyState
          emoji="🫥"
          title="Çelınc bulunamadı"
          subtitle="Bu bağlantıda çelınc numarası yok. Listeden birine dokun."
          actionLabel="Listeye dön"
          onAction={back}
        />
      </Screen>
    );
  }

  if (query.isPending) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Çelınc" />
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
        <Header onBack={back} title="Çelınc" />
        <EmptyState
          emoji={missing ? '🫥' : '📡'}
          title={missing ? 'Bu çelınc sende yok' : 'Çelınc gelmedi'}
          subtitle={
            missing
              ? 'Ya silindi ya da bu çelıncın içinde değilsin.'
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
  // rank 1 is shared on equal scores (0-0 included), so "öndesin" needs the
  // second check — the same rule the list card applies
  const topShared =
    !!mine &&
    accepted.some((p) => p.user.id !== mine.user.id && p.score === mine.score && p.rank === mine.rank);
  const tied = (mine?.rank ?? 0) === 1 && topShared;
  const leading = (mine?.rank ?? 0) === 1 && !topShared;
  /**
   * Who the reader may talk to right now. The server decides — it is the only
   * side that knows the standings AND the cooldowns — and an older server that
   * does not send the field yet simply offers nobody.
   */
  const pokeTargets = detail.pokeTargets ?? [];
  const coolingIds = new Set(pokeTargets.filter((row) => row.done).map((row) => row.toUserId));
  const targets = accepted.filter((p) => pokeTargets.some((row) => row.toUserId === p.user.id));
  /**
   * A pending çelınc whose start time has passed is not starting: the server
   * only activates it once at least two people have accepted, and otherwise
   * cancels it at the end date. Saying "Başlıyor" for days would be a lie.
   */
  // `renderedAt` is captured once per mount rather than read during render:
  // the React Compiler treats `Date.now()` in render as impure, and a start
  // time that passes while the screen is open is picked up by the countdown's
  // own refetch anyway.
  const startsAtMs = Date.parse(challenge.startsAt);
  const startPassed = Number.isFinite(startsAtMs) ? startsAtMs <= renderedAt : false;
  const waitingForAccepts = challenge.status === 'pending' && startPassed;
  const isCreator = challenge.creatorId === meId;
  // The last fetch is a fresh enough clock for an answer window counted in
  // hours, and unlike `Date.now()` it is a pure read.
  const clock = Math.max(renderedAt, query.dataUpdatedAt);
  const awaitingProof = detail.feed.some(
    (item) => item.status === 'disputed' && !!item.answerBy && Date.parse(item.answerBy) > clock
  );

  return (
    <Screen
      scroll
      glow
      onRefresh={() => void query.refetch()}
      refreshing={query.isRefetching}
      contentStyle={styles.content}
      bottomInset={Spacing.xxl}>
      <Header onBack={back} title={type?.nameTr ?? 'Çelınc'} />

      {/* --------------------------------------------------------- hero */}
      <Card glow={challenge.status === 'active'} edgeColor={status.color}>
        <View style={styles.heroTop}>
          <Text style={styles.heroEmoji}>{type?.emoji ?? '🎯'}</Text>
          <View style={styles.heroBody}>
            <Text variant="title" numberOfLines={2}>
              {challenge.title || type?.nameTr || 'Çelınc'}
            </Text>
            <Text variant="tiny" muted numberOfLines={1}>
              {accepted.length} kişi · {type?.unitTr ?? ''}
            </Text>
          </View>
          <Chip label={status.label} color={status.color} size="sm" filled={challenge.status === 'active'} />
        </View>

        <View style={styles.heroClock}>
          {waitingForAccepts ? (
            <>
              <Text variant="label">Kabul bekleniyor</Text>
              <Text variant="big">{accepted.length}/2 kişi</Text>
              <Text variant="tiny" faint>
                En az 2 kişi kabul edene kadar süre işlemiyor. Kimse kabul etmezse bitiş
                tarihinde kendiliğinden iptal olur.
                {isCreator ? ' İstersen aşağıdan şimdi iptal edebilirsin.' : ''}
              </Text>
            </>
          ) : challenge.status === 'pending' ? (
            <>
              <Text variant="label">Başlamasına</Text>
              <Countdown
                target={challenge.startsAt}
                variant="big"
                finishedLabel="Başlıyor"
                onFinish={() => void query.refetch()}
              />
            </>
          ) : settling ? (
            <>
              <Text variant="label">Süre bitti</Text>
              <Text variant="big">{awaitingProof ? 'Kanıt bekleniyor' : 'Sonuç birazdan'}</Text>
              <Text variant="tiny" faint>
                {settlingNote(type, awaitingProof)}
              </Text>
            </>
          ) : challenge.status === 'active' ? (
            <>
              <Text variant="label">Bitmesine</Text>
              <Countdown
                target={challenge.endsAt}
                variant="big"
                finishedLabel="Süre doldu"
                onFinish={() => {
                  setRenderedAt(Date.now());
                  void query.refetch();
                }}
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
        <Standings
          participants={participants}
          type={type}
          meId={meId}
          finished={challenge.status === 'finished'}
          onPressUser={(userId) => router.push({ pathname: '/user/[id]', params: { id: userId } })}
        />
        {/* "küçük bir gayret yeter" is a lie once nothing more counts */}
        {challenge.status === 'active' && !settling && isPlayer ? (
          <Text
            variant="small"
            bold
            color={leading ? Colors.success : tied ? Colors.info : Colors.accent}
            style={styles.verdict}>
            {t(
              leading ? 'challenge_active_leading' : tied ? 'challenge_active_tie' : 'challenge_active_losing',
              level
            )}
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
        <InviteActions id={id} level={level} endsIt={endsWithoutMe(participants, meId)} />
      ) : null}
      {/* a "Reddet" is not final while the çelınc still takes players */}
      {mine?.status === 'declined' && (challenge.status === 'pending' || (challenge.status === 'active' && !settling)) ? (
        <RejoinCard id={id} level={level} />
      ) : null}

      {/* ------------------------------------------------------- actions */}
      {challenge.status === 'active' && !settling && isPlayer && type ? (
        <ActionArea
          id={id}
          detail={detail}
          type={type}
          level={level}
          today={today}
          yesterday={yesterday}
          dayKeys={dayKeys}
          tz={tz}
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
        now={clock}
        onProof={setProofUrl}
      />

      {/* --------------------------------------------------------- pokes */}
      {challenge.status === 'active' && isPlayer && targets.length > 0 ? (
        <PokeSection
          id={id}
          challenge={challenge}
          rivals={targets}
          cooling={coolingIds}
          me={mine}
          level={level}
        />
      ) : null}

      {/* -------------------------------------------------------- footer */}
      <FooterActions
        id={id}
        detail={detail}
        meId={meId}
        settling={settling}
        onLeft={back}
      />

      <Sheet visible={!!proofUrl} onClose={() => setProofUrl(null)} title="Kanıt" scroll={false}>
        {proofUrl ? (
          <Image
            source={{ uri: resolveServerUrl(proofUrl, serverUrl) }}
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

function InviteActions({ id, level, endsIt }: { id: string; level: VulgarityLevel; endsIt: boolean }) {
  const action = useChallengeAction(id);
  const toast = useToast();

  const run = async (kind: 'accept' | 'decline') => {
    if (kind === 'decline') {
      const question = declineQuestion(level, endsIt);
      if (!(await confirmTr(question.title, question.body, 'Reddet'))) return;
    }
    try {
      await action.mutateAsync(kind);
      toast({
        title: kind === 'accept' ? 'Girdin' : 'Kaçtın',
        body:
          kind === 'accept'
            ? 'Skorun sayılmaya başladı.'
            : endsIt
              ? 'Rakip kalmadı, çelınc iptal oldu.'
              : 'Bu çelınc sensiz devam ediyor.',
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

/**
 * The way back from a "Reddet": the server lets a declined invite accept while
 * the çelınc still takes players. Too late (its last hour) comes back as the
 * server's own words in the toast.
 */
function RejoinCard({ id, level }: { id: string; level: VulgarityLevel }) {
  const action = useChallengeAction(id);
  const toast = useToast();

  const join = () => {
    action.mutate('accept', {
      onSuccess: () => {
        toast({
          title: 'Girdin',
          body: byLevel(
            level,
            'Çelınc yine listende. Kolay gelsin.',
            'Çelınc yine listende. Bastır bakalım.',
            'Çelınc yine listende. Göster kendini 🍆'
          ),
          kind: 'success',
        });
      },
      onError: (error) => {
        toast({ title: 'Olmadı', body: errorText(error, 'Katılamadın.'), kind: 'danger' });
      },
    });
  };

  return (
    <Card edgeColor={Colors.yellow}>
      <View style={styles.actionBody}>
        <Text variant="small">
          {byLevel(
            level,
            'Bu daveti reddetmiştin. Fikrin değiştiyse hâlâ katılabilirsin.',
            'Reddetmiştin. Fikrin değiştiyse hâlâ girebilirsin.',
            'Tırsmıştın 🐔 Adamlığın yetiyorsa hâlâ girebilirsin.'
          )}
        </Text>
        <Button title="Katıl" size="md" fullWidth loading={action.isPending} onPress={join} />
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
  /** the account's IANA zone — the one the server counts days and deadlines in */
  tz: string;
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
  const queryClient = useQueryClient();
  const refreshMe = useAuth((s) => s.refreshMe);
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
      // one sync fans out to every auto_steps çelınc, so it refreshes the list
      // and me.stats too — not just this screen
      const result = await syncStepsNow({ client: api, queryClient, refreshMe });
      if (result.days === 0) {
        toast({
          title: 'Sayacak adım yok',
          body: 'Telefon henüz adım vermedi. Biraz yürü, sonra tekrar dene.',
          kind: 'info',
        });
        return;
      }
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
          Yaklaşık (uygulama açıkken sayılıyor). Sayaç eksik kalırsa değeri elle gir.
        </Text>
      ) : null}
      {unavailable ? (
        <Text variant="tiny" faint>
          {stepsReason(availability)} Skorun sıfır kalmasın diye günlük adımını elle girebilirsin.
        </Text>
      ) : null}
    </View>
  );
}

function stepsReason(availability: StepAvailability | null): string {
  if (!availability || availability.available) return '';
  switch (availability.reason) {
    case 'web':
      return 'Adımlar telefondan sayılıyor, tarayıcıda sayaç yok.';
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

function CheckinAction({ id, detail, level, today, tz }: ActionProps) {
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
      if (response.queued || !response.entry) {
        // offline: the check-in is parked and will be sent when we are back
        setResult('ok');
        toast({
          title: 'Kaydedildi',
          body: 'Şu an sunucuya ulaşamadım. Bağlantı gelince gönderilecek.',
          kind: 'info',
        });
        return;
      }
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
          Kayıt saati: {formatTime(entry.createdAt, tz)}
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
      const response = await addEntry.mutateAsync({
        dayKey,
        value,
        source: 'manual',
        clientTime: nowIso(),
      });
      if (response.queued) {
        // parked offline: the standings do not move until the queue drains
        toast({
          title: 'Sıraya alındı',
          body: 'Şu an sunucuya ulaşamadım. Bağlantı gelince gönderilecek.',
          kind: 'info',
        });
        return;
      }
      toast({
        title: value === 1 ? 'Yaptın' : 'Yapmadın',
        body: value === 1 ? 'Gün senin lehine yazıldı.' : 'Yarın telafi edersin.',
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
  const addEntry = useAddEntry(id, { append: true });
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
      const response = await addEntry.mutateAsync({
        dayKey: today,
        value,
        source: 'manual',
        clientTime: nowIso(),
        // replay-safe: the queue may resend this exact tap after a timeout
        sessionId: uuidV4(),
      });
      toast(
        response.queued
          ? {
              title: 'Sıraya alındı',
              body: `+${formatNumber(value)} ${type.unitTr} · bağlantı gelince gönderilecek.`,
              kind: 'info',
            }
          : { title: `+${formatNumber(value)} ${type.unitTr}`, body: 'Yazıldı.', kind: 'success' }
      );
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

      {detail.challenge.proofRequired ? (
        <Text variant="tiny" faint>
          Bu çelıncta kanıt fotoğrafı isteniyor. Hızlı ekleme yerine “+ Giriş” kullan.
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

/**
 * Screen time is the one number the phone may or may not be able to give us.
 * Android with usage access: the phone reads it, the manual button disappears
 * (the server refuses to let a typed value replace a device reading anyway).
 * iPhone / Expo Go / no permission: the honest fallback, a typed value with a
 * screenshot, plus the one-tap permission request where that is the blocker.
 */
function LowerAction({ id, detail, type, level, today }: ActionProps) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const refreshMe = useAuth((s) => s.refreshMe);
  const [availability, setAvailability] = useState<ScreenTimeAvailability | null>(null);
  const [deviceMinutes, setDeviceMinutes] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const deviceFed = type.deviceMetric === 'screen_time';

  // Read on mount and every time the app comes back — the user may just have
  // flipped the usage-access switch in system settings.
  useEffect(() => {
    if (!deviceFed) return;
    let alive = true;
    const read = async () => {
      try {
        const next = await getScreenTimeAvailability();
        if (!alive) return;
        setAvailability(next);
        const value = next.available ? await getTodayScreenMinutes() : null;
        if (alive) setDeviceMinutes(value);
      } catch {
        if (alive) setAvailability({ available: false, reason: 'error' });
      }
    };
    void read();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void read();
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [deviceFed]);

  const entry = detail.myEntries.find((e) => e.dayKey === today);
  const deviceOn = deviceFed && availability?.available === true;
  const needsPermission = deviceFed && availability?.available === false && availability.reason === 'permission';
  const locked = entry?.source === 'usage_stats';
  const shown = deviceOn ? (deviceMinutes ?? entry?.value ?? null) : (entry?.value ?? null);

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await syncScreenTimeNow({ client: api, queryClient, refreshMe });
      if (result.days === 0) {
        toast({ title: 'Telefon değer vermedi', body: 'Kullanım erişimi açık mı diye bir bak.', kind: 'info' });
        return;
      }
      // the number on this screen and the one just sent should agree from here on
      setDeviceMinutes(await getTodayScreenMinutes());
      toast({ title: 'Ekran süresi gitti', body: `${formatNumber(result.updated)} gün güncellendi.`, kind: 'success' });
    } catch (error) {
      toast({ title: 'Senkron olmadı', body: errorText(error, 'Ekran süresi gönderilemedi.'), kind: 'danger' });
    } finally {
      setSyncing(false);
    }
  };

  const askPermission = async () => {
    const opened = await requestScreenTimePermission();
    if (!opened) {
      toast({
        title: 'Ayarlar açılamadı',
        body: 'Ayarlar → Uygulamalar → Özel uygulama erişimi → Kullanım erişimi yolunu kendin dene.',
        kind: 'danger',
      });
    }
  };

  return (
    <View style={styles.actionBody}>
      <View style={styles.bigValueRow}>
        <Text variant="huge" numberOfLines={1} adjustsFontSizeToFit>
          {shown === null ? '—' : formatNumber(shown)}
        </Text>
        <Text variant="small" muted style={styles.bigValueUnit}>
          {type.unitTr} · bugün
        </Text>
      </View>
      <Text variant="tiny" faint>
        Az olan kazanır. Girmediğin gün {formatNumber(type.missingDayPenalty ?? type.maxPerDay)}{' '}
        {type.unitTr} sayılır.
      </Text>

      {deviceOn ? (
        <>
          {entry && deviceMinutes !== null && deviceMinutes !== entry.value ? (
            <Text variant="tiny" faint>
              Telefon {formatNumber(deviceMinutes)} diyor, sunucuda {formatNumber(entry.value)} yazıyor. Senkronla.
            </Text>
          ) : null}
          <Button
            title="Senkronla"
            icon="🔄"
            size="lg"
            fullWidth
            loading={syncing}
            onPress={() => void sync()}
          />
          <Text variant="tiny" faint>
            📱 Ekran süren telefondan okunuyor, elle giriş yok. Uygulama her açılışta kendisi gönderir.
          </Text>
        </>
      ) : needsPermission ? (
        <>
          <Button
            title="Kullanım erişimi ver"
            icon="🔓"
            size="lg"
            fullWidth
            onPress={() => void askPermission()}
          />
          <Text variant="tiny" faint>
            Bir kere izin verirsen ekran süren telefondan okunur, ekran görüntüsüyle uğraşmazsın.
          </Text>
          <Button
            title={entry ? 'Bugünkü değeri düzelt' : 'Şimdilik elle gir'}
            variant="ghost"
            size="sm"
            onPress={() => openEntryModal(id, today, true)}
          />
        </>
      ) : (
        <>
          {detail.challenge.proofRequired ? (
            <Text variant="tiny" color={Colors.yellow}>
              📸 {t('proof_needed', level)}
            </Text>
          ) : null}
          {locked ? (
            <Text variant="tiny" faint>
              Bugünün değerini telefon okudu, elle değiştirilemez.
            </Text>
          ) : (
            <Button
              title={entry ? 'Bugünkü değeri düzelt' : 'Bugünkü değeri gir'}
              size="lg"
              fullWidth
              onPress={() => openEntryModal(id, today, true)}
            />
          )}
          {deviceFed && availability?.available === false ? (
            <Text variant="tiny" faint>
              {screenTimeReason(availability)}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

function screenTimeReason(availability: ScreenTimeAvailability): string {
  if (availability.available) return '';
  switch (availability.reason) {
    case 'ios':
      return 'iPhone ekran süresini hiçbir uygulamaya vermiyor, Apple kuralı. Ekran Süresi ekranındaki toplamı ekran görüntüsüyle giriyorsun.';
    case 'web':
      return 'Tarayıcıda ekran süresi okunamıyor.';
    case 'needs-native-module':
      return 'Bu sürüm ekran süresini okuyamıyor (Expo Go). Gerçek APK\'da telefondan otomatik gelir.';
    case 'error':
      return `Ekran süresi okunurken hata çıktı${availability.detail ? ` (${availability.detail})` : ''}.`;
    default:
      return '';
  }
}

/* ------------------------------------------------------------------- feed */

/** "12": the hours an entry's owner gets to answer a majority itiraz. */
const ANSWER_HOURS = Math.round(LIMITS.DISPUTE_ANSWER_MS / 3_600_000);

/** What a disputed row says under its source line. */
function disputeStatusText(item: FeedItem, isMine: boolean, active: boolean, now: number): string {
  if (!active) return 'İtiraz çoğunluğu bulamadı, giriş sayıldı.';
  const answerBy = item.answerBy ? Date.parse(item.answerBy) : Number.NaN;
  // below the majority there is no clock yet (and an older server sends none)
  if (!Number.isFinite(answerBy)) return 'İtiraz var ama henüz çoğunluk değil.';
  const left = answerBy - now;
  if (left <= 0) return 'Kanıt gelmedi, birazdan yanar.';
  return isMine
    ? `İtiraz var. ${formatRemaining(left)} içinde kanıt eklemezsen yanar.`
    : `İtiraz var. ${formatRemaining(left)} içinde kanıt gelmezse yanar.`;
}

function Feed({
  detail,
  type,
  meId,
  today,
  yesterday,
  level,
  baseUrl,
  challengeId,
  now,
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
  /** one clock reading for every row's "x içinde" */
  now: number;
  onProof: (url: string) => void;
}) {
  const dispute = useDispute(challengeId);
  const withdraw = useWithdrawDispute(challengeId);
  const addProof = useAddEntryProof(challengeId);
  const photo = useProofPhoto();
  const removeEntry = useDeleteEntry(challengeId);
  const toast = useToast();
  const [target, setTarget] = useState<FeedItem | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [answering, setAnswering] = useState<FeedItem | null>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);

  // Only a friend's itiraz could undo a mistyped value before this: the server
  // lets you delete your own manual rows while the çelınc is running.
  const active = detail.challenge.status === 'active';
  // A new itiraz is refused from the end on, except in the hour a phone-counted
  // çelınc waits for the last evening's numbers (the server's disputesCloseAt):
  // an "itiraz et" chip after that would only earn a 400.
  const disputesCloseAt =
    Date.parse(detail.challenge.endsAt) + (type?.deviceMetric ? LIMITS.DEVICE_SETTLE_MS : 0);
  // a malformed end date leaves the call to the server rather than hiding the chip
  const canDispute = active && (!Number.isFinite(disputesCloseAt) || now < disputesCloseAt);
  const canDelete = (item: FeedItem) =>
    active && item.userId === meId && item.source === 'manual' && item.status !== 'rejected';

  const remove = async (item: FeedItem) => {
    const label = type ? scoreLabel(type, item.value) : formatNumber(item.value);
    const ok = await confirmTr(
      'Girişi sil',
      `${formatDayKeyFriendly(item.dayKey, today, yesterday)} · ${label} silinecek. Skorundan düşer.`,
      'Sil'
    );
    if (!ok) return;
    setRemovingId(item.id);
    try {
      await removeEntry.mutateAsync(item.id);
      toast({ title: 'Silindi', body: 'Giriş skorundan düştü.', kind: 'info' });
    } catch (err) {
      toast({ title: 'Silinemedi', body: errorText(err, 'Giriş silinemedi.'), kind: 'danger' });
    } finally {
      setRemovingId(null);
    }
  };

  // Who said what, per entry: the reason is the whole point of an itiraz, and
  // the owner cannot answer an accusation they cannot read.
  const names = new Map(detail.participants.map((p) => [p.user.id, p.user.displayName]));
  const disputesByEntry = new Map<string, Dispute[]>();
  for (const row of detail.disputes) {
    const list = disputesByEntry.get(row.entryId) ?? [];
    list.push(row);
    disputesByEntry.set(row.entryId, list);
  }
  const myDisputes = new Map(
    detail.disputes.filter((d) => d.byUserId === meId).map((d) => [d.entryId, d.status])
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

  const takeBack = async (item: FeedItem) => {
    const ok = await confirmTr(
      'İtirazı geri çek',
      `${item.displayName} · ${formatDayKeyFriendly(item.dayKey, today, yesterday)} girişine itirazın kalkar. Bu girişe bir daha itiraz edemezsin.`,
      'Geri çek'
    );
    if (!ok) return;
    setWithdrawingId(item.id);
    try {
      await withdraw.mutateAsync(item.id);
      toast({
        title: 'Geri çektin',
        body: byLevel(level, 'İtirazın kalktı.', 'İtirazın kalktı, helal.', 'İtirazın kalktı. Adamlık sende 🍆'),
        kind: 'info',
      });
    } catch (err) {
      toast({ title: 'Geri çekilemedi', body: errorText(err, 'İtiraz geri çekilemedi.'), kind: 'danger' });
    } finally {
      setWithdrawingId(null);
    }
  };

  const openAnswer = (item: FeedItem) => {
    setAnswering(item);
    setPickedUrl(null);
  };

  const pickProof = async (from: 'camera' | 'library') => {
    const url = await photo.pick(from);
    if (url) setPickedUrl(url);
  };

  const sendProof = async () => {
    if (!answering || !pickedUrl) return;
    try {
      await addProof.mutateAsync({ entryId: answering.id, proofUrl: pickedUrl });
      toast({
        title: byLevel(level, 'Kanıt eklendi', 'Kanıt gitti', 'Kanıtı koydun 🍆'),
        body: 'İtiraz kapandı, giriş sayılmaya devam ediyor.',
        kind: 'success',
      });
      setAnswering(null);
      setPickedUrl(null);
    } catch (err) {
      toast({ title: 'Kanıt gitmedi', body: errorText(err, 'Kanıt eklenemedi.'), kind: 'danger' });
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
          {detail.feed.map((item) => {
            const isMine = item.userId === meId;
            // an open itiraz explains a disputed row, an upheld one a rejected row
            const shown = item.status === 'disputed' ? 'open' : item.status === 'rejected' ? 'upheld' : null;
            const reasons = (disputesByEntry.get(item.id) ?? [])
              .filter((row) => row.status === shown)
              .map((row) => ({ id: row.id, name: names.get(row.byUserId) ?? 'Biri', reason: row.reason }));
            return (
              <FeedRow
                key={item.id}
                item={item}
                type={type}
                isMine={isMine}
                myDispute={myDisputes.get(item.id) ?? null}
                reasons={reasons}
                statusText={item.status === 'disputed' ? disputeStatusText(item, isMine, active, now) : null}
                active={active}
                canDispute={canDispute}
                today={today}
                yesterday={yesterday}
                level={level}
                baseUrl={baseUrl}
                onProof={onProof}
                canDelete={canDelete(item)}
                deleting={removingId === item.id}
                withdrawing={withdrawingId === item.id}
                onDelete={() => void remove(item)}
                onWithdraw={() => void takeBack(item)}
                onAnswer={() => openAnswer(item)}
                onDispute={() => {
                  setTarget(item);
                  setReason('');
                  setError(null);
                }}
              />
            );
          })}
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
        <Text variant="tiny" faint>
          Çoğunluk itiraz ederse sahibinin {ANSWER_HOURS} saati olur: fotoğraf eklemezse giriş yanar.
        </Text>
        <Button
          title="İtirazı gönder"
          fullWidth
          loading={dispute.isPending}
          onPress={() => void submit()}
        />
        <Button title="Vazgeç" variant="ghost" fullWidth onPress={() => setTarget(null)} />
      </Sheet>

      <Sheet visible={!!answering} onClose={() => setAnswering(null)} title="Kanıt ekle">
        <Text variant="small" muted>
          {answering ? `${formatDayKeyFriendly(answering.dayKey, today, yesterday)} · ` : ''}
          {answering && type ? scoreLabel(type, answering.value) : ''}
        </Text>
        <Text variant="small">
          {byLevel(
            level,
            'Bir fotoğraf ekle, itiraz kapansın. Giriş sayılmaya devam eder, itiraz edenlere de haber gider.',
            'Fotoğrafı koy, itiraz kapansın. Giriş sayılmaya devam eder, itiraz edenler de bir baksın.',
            'Fotoğrafı koy da ağızlar kapansın 🍆 Giriş sayılmaya devam eder, itiraz edenlere de haber gider.'
          )}
        </Text>
        {pickedUrl ? (
          <>
            <Image
              source={{ uri: resolveServerUrl(pickedUrl, baseUrl) }}
              style={styles.proofPreview}
              contentFit="cover"
              transition={120}
            />
            <Button
              title="Kanıtı gönder"
              fullWidth
              loading={addProof.isPending}
              onPress={() => void sendProof()}
            />
            <Button
              title="Başka fotoğraf seç"
              variant="ghost"
              fullWidth
              disabled={addProof.isPending}
              onPress={() => setPickedUrl(null)}
            />
          </>
        ) : (
          <View style={styles.proofButtons}>
            {Platform.OS !== 'web' ? (
              <Button
                title="Kamera"
                icon="📷"
                variant="secondary"
                style={styles.grow}
                loading={photo.uploading}
                onPress={() => void pickProof('camera')}
              />
            ) : null}
            <Button
              title="Galeri"
              icon="🖼️"
              variant="secondary"
              style={styles.grow}
              loading={photo.uploading}
              onPress={() => void pickProof('library')}
            />
          </View>
        )}
        <Button title="Vazgeç" variant="ghost" fullWidth onPress={() => setAnswering(null)} />
      </Sheet>
    </Card>
  );
}

function FeedRow({
  item,
  type,
  isMine,
  myDispute,
  reasons,
  statusText,
  active,
  canDispute,
  today,
  yesterday,
  level,
  baseUrl,
  onProof,
  onDispute,
  onWithdraw,
  onAnswer,
  canDelete,
  deleting,
  withdrawing,
  onDelete,
}: {
  item: FeedItem;
  type: ChallengeType | undefined;
  isMine: boolean;
  /** where the reader's own itiraz on this entry stands, if they filed one */
  myDispute: DisputeStatus | null;
  reasons: { id: string; name: string; reason: string }[];
  statusText: string | null;
  active: boolean;
  /** whether the server still takes a new itiraz (see Feed) */
  canDispute: boolean;
  today: string;
  yesterday: string;
  level: VulgarityLevel;
  baseUrl: string;
  onProof: (url: string) => void;
  onDispute: () => void;
  onWithdraw: () => void;
  onAnswer: () => void;
  canDelete: boolean;
  deleting: boolean;
  withdrawing: boolean;
  onDelete: () => void;
}) {
  const rejected = item.status === 'rejected';
  const disputed = item.status === 'disputed';

  let chip: ReactNode = null;
  if (!isMine && !rejected) {
    if (active && myDispute === 'open') {
      chip = (
        <Chip
          label={withdrawing ? 'Çekiliyor…' : 'Geri çek'}
          color={Colors.textMuted}
          size="sm"
          onPress={withdrawing ? undefined : onWithdraw}
        />
      );
    } else if (myDispute) {
      chip = <Chip label="İtiraz ettin" color={Colors.textFaint} size="sm" />;
    } else if (canDispute) {
      chip = <Chip label={t('dispute_button', level)} color={Colors.danger} size="sm" onPress={onDispute} />;
    }
  } else if (isMine && disputed && active) {
    chip = <Chip label="Kanıt ekle" icon="📸" color={Colors.yellow} size="sm" onPress={onAnswer} />;
  } else if (canDelete) {
    chip = (
      <Chip
        label={deleting ? 'Siliniyor…' : 'Sil'}
        icon="🗑️"
        color={Colors.textMuted}
        size="sm"
        onPress={deleting ? undefined : onDelete}
      />
    );
  }

  return (
    <View style={styles.feedRow}>
      {item.proofUrl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Kanıtı büyüt"
          onPress={() => onProof(item.proofUrl as string)}>
          <Image
            source={{ uri: resolveServerUrl(item.proofUrl, baseUrl) }}
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
        ) : disputed && statusText ? (
          <Text variant="tiny" color={Colors.yellow}>
            {statusText}
          </Text>
        ) : null}
        {reasons.map((row) => (
          <Text key={row.id} variant="tiny" color={rejected ? Colors.textFaint : Colors.yellow} numberOfLines={2}>
            {`${row.name}: “${row.reason}”`}
          </Text>
        ))}
      </View>

      {chip}
    </View>
  );
}

/* ------------------------------------------------------------------ pokes */

/**
 * Talking while the çelınc is still running.
 *
 * It is a privilege, not a button everybody has: the server only lists rivals
 * the reader is genuinely ahead of (`pokeTargets`), and pressing the button
 * opens the same choice the winner gets at the end — a handful of ready lines,
 * rendered with the real names and scores, pick one and it goes.
 */
function PokeSection({
  id,
  challenge,
  rivals,
  cooling,
  me,
  level,
}: {
  id: string;
  challenge: Challenge;
  rivals: ParticipantView[];
  cooling: Set<string>;
  me: ParticipantView | undefined;
  level: VulgarityLevel;
}) {
  const poke = usePoke(id);
  const toast = useToast();
  const [blocked, setBlocked] = useState<Record<string, number>>({});
  const [picking, setPicking] = useState<ParticipantView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  // Keep the "x dk sonra" note honest while the screen stays open — but only
  // while a cooldown is actually running. Re-arming per tick means the chain
  // stops by itself once the last cooldown expires, instead of re-rendering
  // this card every 30 s for a value that is almost always absent.
  useEffect(() => {
    if (!Object.values(blocked).some((until) => until > Date.now())) return;
    const timer = setTimeout(() => setTick(Date.now()), 30_000);
    return () => clearTimeout(timer);
  }, [blocked, tick]);

  if (rivals.length === 0) return null;

  // One clock reading per render: `tick` is seeded from the clock and moved
  // forward by the timer above while a cooldown is running.
  const now = tick;
  const type = getChallengeType(challenge.typeKey);
  const scoreText = (value: number) => scoreLabel({ unitTr: challenge.unit }, value);

  /** The lines on offer, filled in with who is where. */
  const linesFor = (rival: ParticipantView) => {
    const vars: TauntVars = {
      winner: me?.user.displayName ?? 'Sen',
      loser: rival.user.displayName,
      metric: type?.nameTr ?? challenge.title,
      winnerScore: formatNumberTr(me?.score ?? 0),
      loserScore: formatNumberTr(rival.score),
      diff: formatNumberTr(Math.abs((me?.score ?? 0) - rival.score)),
      unit: challenge.unit,
      challenge: challenge.title,
    };
    return tauntsAtLevel('poke', level, challenge.metricType).map((template) => ({
      id: template.id,
      ...renderTaunt(template, vars),
    }));
  };

  const send = async (rival: ParticipantView, templateId: string) => {
    setPending(templateId);
    try {
      await poke.mutateAsync({ toUserId: rival.user.id, templateId });
      setBlocked((prev) => ({ ...prev, [rival.user.id]: Date.now() + LIMITS.POKE_COOLDOWN_MS }));
      setPicking(null);
      toast({
        title: byLevel(level, 'Gitti', 'Soktun', 'Soktun 🍆'),
        body: `${rival.user.displayName} şu an titredi.`,
        kind: 'taunt',
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'poke_cooldown') {
        setBlocked((prev) => ({ ...prev, [rival.user.id]: Date.now() + LIMITS.POKE_COOLDOWN_MS }));
        setPicking(null);
        toast({ title: 'Çok sık oldu', body: error.message, kind: 'info' });
      } else {
        toast({ title: 'Gönderemedim', body: errorText(error, 'Gönderilemedi.'), kind: 'danger' });
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <Text variant="label" style={styles.sectionLabel}>
        {byLevel(level, 'Mesaj gönder', 'Laf sok', 'Laf sok 🍆')}
      </Text>
      <Text variant="tiny" muted style={styles.pokeNote}>
        {byLevel(
          level,
          'Öndesin, bir mesaj gönderebilirsin.',
          'Öndesin, laf sokma hakkı sende.',
          'Öndesin. Laf sokma hakkı senin 🍆'
        )}
      </Text>
      <View style={styles.pokeList}>
        {rivals.map((rival) => {
          const until = blocked[rival.user.id] ?? 0;
          const coolingNow = until > now || cooling.has(rival.user.id);
          return (
            <View key={rival.user.id} style={styles.pokeRow}>
              <Avatar emoji={rival.user.avatarEmoji} name={rival.user.displayName} size={34} />
              <View style={styles.pokeBody}>
                <Text variant="small" bold numberOfLines={1}>
                  {rival.user.displayName}
                </Text>
                <Text variant="tiny" faint numberOfLines={1}>
                  {coolingNow
                    ? until > now
                      ? `Tekrar sokmak için ${formatRemaining(until - now)}`
                      : 'Az önce soktun, biraz beklet'
                    : `${scoreText(rival.score)} · ${rival.rank}. sırada`}
                </Text>
              </View>
              <Button
                title={t('poke_button', level)}
                size="sm"
                variant={coolingNow ? 'ghost' : 'secondary'}
                disabled={coolingNow}
                onPress={() => setPicking(rival)}
              />
            </View>
          );
        })}
      </View>

      <Sheet
        visible={!!picking}
        onClose={() => setPicking(null)}
        title={picking ? `${picking.user.displayName}'a ne diyelim?` : ''}>
        {picking
          ? linesFor(picking).map((line) => (
              <Pressable
                key={line.id}
                accessibilityRole="button"
                disabled={pending !== null}
                onPress={() => void send(picking, line.id)}
                style={({ pressed }) => [styles.pokeOption, pressed && styles.pokeOptionOn]}>
                <Text variant="small" bold>
                  {line.title}
                </Text>
                <Text variant="tiny" muted>
                  {line.body}
                </Text>
              </Pressable>
            ))
          : null}
      </Sheet>
    </Card>
  );
}

/* ----------------------------------------------------------------- footer */

function FooterActions({
  id,
  detail,
  meId,
  settling,
  onLeft,
}: {
  id: string;
  detail: ChallengeDetail;
  meId: string | null;
  /** past the end the server only waits, and leaving would void the result */
  settling: boolean;
  onLeft: () => void;
}) {
  const action = useChallengeAction(id);
  const toast = useToast();
  const { challenge, me: mine } = detail;

  const canLeave =
    (challenge.status === 'pending' || (challenge.status === 'active' && !settling)) &&
    (mine?.status === 'accepted' || mine?.status === 'invited');
  const canCancel = challenge.status === 'pending' && challenge.creatorId === meId;
  const finished = challenge.status === 'finished';

  // leaving a head-to-head leaves nobody to race: the server cancels it on the spot
  const leavingEndsIt = endsWithoutMe(detail.participants, meId);

  const run = async (kind: 'leave' | 'cancel') => {
    const ok = await confirmTr(
      kind === 'leave' ? 'Ayrılıyor musun?' : 'Çelıncı iptal et',
      kind === 'leave'
        ? leavingEndsIt
          ? 'Başka kimse kalmadığı için çelınc iptal olur, rakibine de haber gider.'
          : 'Skorun silinmez ama sıralamadan düşersin. Kankalar bunu görecek.'
        : 'Herkese iptal bildirimi gider. Emin misin?',
      kind === 'leave' ? 'Ayrıl' : 'İptal et'
    );
    if (!ok) return;
    try {
      await action.mutateAsync(kind);
      toast({
        title: kind === 'leave' ? 'Ayrıldın' : 'İptal edildi',
        body:
          kind === 'cancel'
            ? 'Çelınc kapandı.'
            : leavingEndsIt
              ? 'Rakip kalmadı, çelınc iptal oldu.'
              : 'Bu çelınc sensiz devam ediyor.',
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
  proofButtons: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  proofPreview: { width: '100%', height: 220, borderRadius: Radius.md, backgroundColor: Colors.surfaceHigh },
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
  pokeNote: { marginBottom: Spacing.sm },
  pokeOption: {
    gap: 2,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    marginBottom: Spacing.sm,
  },
  pokeOptionOn: { borderColor: Colors.accent, backgroundColor: Colors.surfaceHigh },
  pokeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  pokeBody: { flex: 1, gap: 2 },

  footer: { gap: Spacing.sm, marginTop: Spacing.sm },
});
