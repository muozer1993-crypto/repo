import type { ChallengeSummary, VulgarityLevel } from '@koydum/shared';
import { TAGLINE, getChallengeType, t } from '@koydum/shared';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ChallengeCard } from '@/components/ChallengeCard';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useChallengeAction, useChallenges } from '@/hooks/queries';
import { useApi } from '@/hooks/useApi';
import { ApiError } from '@/lib/api';
import {
  getDailySteps,
  getStepAvailability,
  getTodaySteps,
  openHealthConnectSettingsIfPossible,
  requestStepPermission,
  type StepAvailability,
} from '@/services/steps';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Shadow, Spacing } from '@/theme';
import { formatNumber } from '@/utils/format';

const LEVEL_LABEL: Record<VulgarityLevel, string> = {
  1: 'NAZİK',
  2: 'ARGO',
  3: 'AĞIR ABİ',
};

const LEVEL_COLOR: Record<VulgarityLevel, string> = {
  1: Colors.info,
  2: Colors.yellow,
  3: Colors.accent,
};

export default function HomeScreen() {
  const level = useLevel();
  const me = useAuth((s) => s.me);
  const refreshMe = useAuth((s) => s.refreshMe);
  const challenges = useChallenges();
  const steps = useStepsHeader();

  const list = challenges.data ?? [];
  const invited = list
    .filter((s) => s.me?.status === 'invited' && s.challenge.status !== 'cancelled')
    .sort(byNewest);
  const active = list
    .filter((s) => s.challenge.status === 'active' && s.me?.status !== 'invited')
    .sort((a, b) => time(a.challenge.endsAt) - time(b.challenge.endsAt));
  const pending = list
    .filter((s) => s.challenge.status === 'pending' && s.me?.status !== 'invited')
    .sort((a, b) => time(a.challenge.startsAt) - time(b.challenge.startsAt));
  const finished = list
    .filter((s) => s.challenge.status === 'finished' || s.challenge.status === 'cancelled')
    .sort(
      (a, b) =>
        time(b.challenge.finalizedAt ?? b.challenge.endsAt) -
        time(a.challenge.finalizedAt ?? a.challenge.endsAt)
    )
    .slice(0, 5);

  const nothingAtAll =
    !challenges.isPending && !challenges.isError && list.length === 0;

  const openChallenge = (id: string) => {
    router.push({ pathname: '/challenge/[id]', params: { id } });
  };

  const refresh = () => {
    void challenges.refetch();
    void steps.reload();
    void refreshMe();
  };

  return (
    <View style={styles.root}>
      <Screen
        glow
        onRefresh={refresh}
        refreshing={challenges.isRefetching}
        bottomInset={Spacing.xxxl + Spacing.xxl}>
        <View style={styles.headerRow}>
          <View style={styles.brand}>
            <Text variant="big" color={Colors.accent} style={styles.wordmark}>
              KOYDUM
            </Text>
            <Text variant="tiny" faint numberOfLines={2}>
              {level === 1 ? TAGLINE.level1 : level === 3 ? TAGLINE.level3 : TAGLINE.level2}
            </Text>
          </View>
          <Chip
            label={LEVEL_LABEL[level]}
            color={LEVEL_COLOR[level]}
            size="sm"
            onPress={() => router.push('/settings')}
          />
        </View>

        <StepsHeader state={steps} />

        {challenges.isPending ? (
          <View style={styles.section}>
            <SectionHeader title="Yükleniyor" />
            <Skeleton height={140} style={styles.skeleton} />
            <Skeleton height={140} style={styles.skeleton} />
          </View>
        ) : null}

        {challenges.isError ? (
          <Card style={styles.errorCard} edgeColor={Colors.danger}>
            <Text variant="lead">Liste gelmedi</Text>
            <Text variant="small" muted style={styles.errorBody}>
              {challenges.error instanceof ApiError
                ? challenges.error.message
                : 'Çelinçler yüklenemedi.'}
            </Text>
            <Button
              title="Tekrar dene"
              variant="secondary"
              size="sm"
              style={styles.errorAction}
              onPress={() => void challenges.refetch()}
            />
          </Card>
        ) : null}

        {invited.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Davetler" count={invited.length} emoji="✉️" />
            {invited.map((summary) => (
              <InviteCard
                key={summary.challenge.id}
                summary={summary}
                level={level}
                onOpen={() => openChallenge(summary.challenge.id)}
              />
            ))}
          </View>
        ) : null}

        {active.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Devam eden" count={active.length} emoji="🔥" />
            {active.map((summary) => (
              <ChallengeCard
                key={summary.challenge.id}
                summary={summary}
                level={level}
                meId={me?.id}
                onPress={() => openChallenge(summary.challenge.id)}
              />
            ))}
          </View>
        ) : null}

        {pending.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Başlamadı" count={pending.length} emoji="🚦" />
            {pending.map((summary) => (
              <ChallengeCard
                key={summary.challenge.id}
                summary={summary}
                level={level}
                meId={me?.id}
                onPress={() => openChallenge(summary.challenge.id)}
              />
            ))}
          </View>
        ) : null}

        {finished.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title="Bitenler" count={finished.length} emoji="🏁" />
            {finished.map((summary) => {
              const won =
                !summary.challenge.isTie &&
                !!summary.me &&
                summary.challenge.winnerId === summary.me.user.id;
              return (
                <View key={summary.challenge.id} style={styles.finishedItem}>
                  <ChallengeCard
                    summary={summary}
                    level={level}
                    meId={me?.id}
                    onPress={() => openChallenge(summary.challenge.id)}
                  />
                  {won ? (
                    <Button
                      title="KOYDUM MU?"
                      icon="🍆"
                      size="md"
                      fullWidth
                      onPress={() =>
                        router.push({
                          pathname: '/challenge/[id]/results',
                          params: { id: summary.challenge.id },
                        })
                      }
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {nothingAtAll ? (
          <EmptyState
            emoji="🫥"
            title={t('home_empty', level)}
            subtitle="Bir çelinç aç, kankaları davet et, skorlar kendiliğinden işlesin."
            actionLabel="Çelinç aç"
            onAction={() => router.push('/challenge/new')}
          />
        ) : null}
      </Screen>

      <Button
        title="Çelinç Aç"
        icon="🍆"
        size="lg"
        style={styles.fab}
        onPress={() => router.push('/challenge/new')}
      />
    </View>
  );
}

/* --------------------------------------------------------------- header */

interface StepsState {
  loading: boolean;
  availability: StepAvailability | null;
  today: number | null;
  syncing: boolean;
  reload: () => Promise<void>;
  sync: () => Promise<void>;
  grant: () => Promise<void>;
}

/** Today's steps + the "Senkronla" action, with a reason when the device cannot count. */
function useStepsHeader(): StepsState {
  const api = useApi();
  const toast = useToast();
  const qc = useQueryClient();
  const refreshMe = useAuth((s) => s.refreshMe);

  const [loading, setLoading] = useState(true);
  const [availability, setAvailability] = useState<StepAvailability | null>(null);
  const [today, setToday] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  const reload = async () => {
    setLoading(true);
    try {
      const next = await getStepAvailability();
      setAvailability(next);
      setToday(next.available ? await getTodaySteps() : null);
    } catch {
      setAvailability({ available: false, reason: 'error' });
      setToday(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // run once on mount; `reload` is recreated on every render by design
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      const days = await getDailySteps(7);
      if (days.length === 0) {
        toast({
          title: 'Sayacak adım yok',
          body: 'Telefon henüz adım vermedi. Biraz yürü, sonra tekrar dene.',
          kind: 'info',
        });
        return;
      }
      const result = await api.syncSteps(days);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['challenges'] }),
        refreshMe(),
      ]);
      await reload();
      toast({
        title: 'Adımlar gitti',
        body: `${formatNumber(result.updated)} gün güncellendi.`,
        kind: 'success',
      });
    } catch (error) {
      toast({
        title: 'Senkron olmadı',
        body: error instanceof ApiError ? error.message : 'Adımlar gönderilemedi.',
        kind: 'danger',
      });
    } finally {
      setSyncing(false);
    }
  };

  const grant = async () => {
    const current = availability;
    if (current && !current.available && current.reason === 'health-connect-missing') {
      const opened = await openHealthConnectSettingsIfPossible();
      if (!opened) {
        toast({
          title: 'Health Connect açılmadı',
          body: 'Health Connect uygulamasını kurup adım iznini elle ver.',
          kind: 'info',
        });
      }
      await reload();
      return;
    }
    const granted = await requestStepPermission();
    if (!granted) {
      toast({
        title: 'İzin yok, adım yok',
        body: 'Telefon ayarlarından hareket/adım iznini açman lazım.',
        kind: 'danger',
      });
    }
    await reload();
  };

  return { loading, availability, today, syncing, reload, sync, grant };
}

function StepsHeader({ state }: { state: StepsState }) {
  const { availability, today, loading, syncing } = state;
  const available = availability?.available === true;
  const approximate = availability?.available === true && availability.approximate;

  return (
    <Card style={styles.stepsCard} edgeColor={available ? Colors.success : Colors.border}>
      <View style={styles.stepsRow}>
        <View style={styles.stepsBody}>
          <Text variant="label">Bugün</Text>
          {loading ? (
            <Skeleton height={34} width={140} style={styles.stepsSkeleton} />
          ) : available ? (
            <View style={styles.stepsValueRow}>
              <Text variant="huge" numberOfLines={1} adjustsFontSizeToFit>
                {formatNumber(today ?? 0)}
              </Text>
              <Text variant="small" muted style={styles.stepsUnit}>
                adım
              </Text>
            </View>
          ) : (
            <Text variant="small" muted style={styles.stepsReason}>
              {reasonText(availability)}
            </Text>
          )}
        </View>
        {available ? (
          <Button
            title="Senkronla"
            icon="🔄"
            variant="secondary"
            size="sm"
            loading={syncing}
            onPress={() => void state.sync()}
          />
        ) : canFix(availability) ? (
          <Button
            title={
              availability && !availability.available && availability.reason === 'health-connect-missing'
                ? 'Health Connect'
                : 'İZİN VER'
            }
            variant="secondary"
            size="sm"
            onPress={() => void state.grant()}
          />
        ) : null}
      </View>
      {approximate ? (
        <Text variant="tiny" faint style={styles.stepsNote}>
          Yaklaşık (uygulama açıkken sayılıyor)
        </Text>
      ) : null}
    </Card>
  );
}

function canFix(availability: StepAvailability | null): boolean {
  if (!availability || availability.available) return false;
  if (Platform.OS === 'web') return false;
  return availability.reason === 'denied' || availability.reason === 'health-connect-missing';
}

function reasonText(availability: StepAvailability | null): string {
  if (!availability || availability.available) return '';
  switch (availability.reason) {
    case 'web':
      return 'Adımlar telefondan sayılıyor; tarayıcıda sayaç yok.';
    case 'no-sensor':
      return 'Bu cihazda adım sensörü yok. Değeri elle beyan edebilirsin.';
    case 'denied':
      return 'Adım izni verilmedi. İzin ver, sayaç çalışsın.';
    case 'health-connect-missing':
      return 'Health Connect kurulu değil. Kurup izin verirsen adımlar otomatik gelir.';
    default:
      return availability.detail ?? 'Adımlar okunamadı.';
  }
}

/* -------------------------------------------------------------- pieces */

function SectionHeader({ title, count, emoji }: { title: string; count?: number; emoji?: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text variant="label">
        {emoji ? `${emoji} ` : ''}
        {title}
      </Text>
      {typeof count === 'number' ? (
        <Text variant="micro" faint>
          {count}
        </Text>
      ) : null}
    </View>
  );
}

function InviteCard({
  summary,
  level,
  onOpen,
}: {
  summary: ChallengeSummary;
  level: VulgarityLevel;
  onOpen: () => void;
}) {
  const action = useChallengeAction(summary.challenge.id);
  const toast = useToast();
  const type = getChallengeType(summary.challenge.typeKey);
  const inviter = summary.participants.find((p) => p.user.id === summary.challenge.creatorId)?.user;

  const run = (kind: 'accept' | 'decline') => {
    action.mutate(kind, {
      onSuccess: () => {
        toast({
          title: kind === 'accept' ? 'Kabul ettin' : 'Reddettin',
          body:
            kind === 'accept'
              ? 'Çelinç senin listende. Bastır bakalım.'
              : 'Bu sefer pas geçtin.',
          kind: kind === 'accept' ? 'success' : 'info',
        });
      },
      onError: (error) => {
        toast({
          title: 'Olmadı',
          body: error instanceof ApiError ? error.message : 'Bir şeyler ters gitti.',
          kind: 'danger',
        });
      },
    });
  };

  return (
    <Card onPress={onOpen} edgeColor={Colors.yellow}>
      <View style={styles.inviteHeader}>
        <Text style={styles.inviteEmoji}>{type?.emoji ?? '🎯'}</Text>
        <View style={styles.inviteBody}>
          <Text variant="lead" numberOfLines={1}>
            {summary.challenge.title || type?.nameTr || 'Çelinç'}
          </Text>
          <Text variant="tiny" muted numberOfLines={1}>
            {inviter ? `${inviter.displayName} davet etti` : 'Bir kanka davet etti'}
            {summary.challenge.rewardText ? ` · 🎁 ${summary.challenge.rewardText}` : ''}
          </Text>
        </View>
      </View>

      <Text variant="small" muted style={styles.inviteHint}>
        {t('challenge_pending_you', level)}
      </Text>

      <View style={styles.inviteActions}>
        <Button
          title="Kabul"
          icon="✅"
          size="sm"
          variant="success"
          style={styles.inviteButton}
          loading={action.isPending && action.variables === 'accept'}
          disabled={action.isPending}
          onPress={() => run('accept')}
        />
        <Button
          title="Reddet"
          icon="🚫"
          size="sm"
          variant="ghost"
          style={styles.inviteButton}
          loading={action.isPending && action.variables === 'decline'}
          disabled={action.isPending}
          onPress={() => run('decline')}
        />
      </View>
    </Card>
  );
}

function time(iso: string | null): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function byNewest(a: ChallengeSummary, b: ChallengeSummary): number {
  return time(b.challenge.createdAt) - time(a.challenge.createdAt);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingTop: Spacing.md,
    marginBottom: Spacing.lg,
  },
  brand: { flex: 1, gap: 2 },
  wordmark: { letterSpacing: -1.5 },
  stepsCard: { marginBottom: Spacing.xl },
  stepsRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  stepsBody: { flex: 1, gap: 2 },
  stepsValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.sm },
  stepsUnit: {},
  stepsReason: { paddingRight: Spacing.sm },
  stepsSkeleton: { marginTop: Spacing.xs },
  stepsNote: { marginTop: Spacing.sm },
  section: { gap: Spacing.md, marginBottom: Spacing.xl },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  finishedItem: { gap: Spacing.sm },
  skeleton: { borderRadius: Radius.lg },
  errorCard: { marginBottom: Spacing.xl },
  errorBody: { marginTop: Spacing.xs },
  errorAction: { marginTop: Spacing.md, alignSelf: 'flex-start' },
  inviteHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  inviteEmoji: { fontSize: 28 },
  inviteBody: { flex: 1, gap: 2 },
  inviteHint: { marginTop: Spacing.md },
  inviteActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.lg },
  inviteButton: { flex: 1 },
  fab: {
    position: 'absolute',
    right: Spacing.lg,
    bottom: Spacing.xl,
    paddingHorizontal: Spacing.xl,
    ...Shadow.glowAccent,
  },
});
