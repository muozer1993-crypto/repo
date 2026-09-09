import type { ChallengeType, ParticipantView, Taunt, VulgarityLevel } from '@koydum/shared';
import { getChallengeType, scoreLabel, t } from '@koydum/shared';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { Standings } from '@/components/Standings';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useChallenge, useRematch, useResults } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { useTimezone } from '@/hooks/useTimezone';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { USE_NATIVE_DRIVER, useAnimatedValue } from '@/utils/animation';
import { safeDayKey } from '@/utils/datetime';
import { errorText } from '@/utils/errors';
import { formatDayKey, relativeTime } from '@/utils/format';
import {
  REMATCH_WINNER,
  TAUNT_ALL,
  TAUNT_ALL_DONE,
  TAUNT_ALL_ICON,
  TAUNT_CTA,
  TAUNT_DONE_CHIP,
} from '@/utils/levelCopy';

/* ------------------------------------------------------------------- copy */

/** Instruction under the "laf hakkı senin" header — the headline already carries the gloat. */
const TAUNT_PROMPT: Record<VulgarityLevel, string> = {
  1: 'Kime mesaj göndereceğini seç.',
  2: 'Kime koyacağını seç, gerisini biz yazarız.',
  3: 'Kime saplayacağını seç. Lafı biz yazdık 🍆',
};

const WIN_TITLE: Record<VulgarityLevel, string> = {
  1: 'KAZANDIN',
  2: 'KOYDUN LAN',
  3: 'SAPLADIN 🍆',
};

const TIE_TITLE: Record<VulgarityLevel, string> = {
  1: 'BERABERE',
  2: 'BERABERE LAN',
  3: 'KİMSE KOYAMADI',
};

const TIE_SUB: Record<VulgarityLevel, string> = {
  1: 'Kimse öne geçemedi. Rövanş açabilirsin.',
  2: 'Kimse öne geçemedi. Rövanş aç da biri yesin.',
  3: 'Ortada sahipsiz bir 🍆 kaldı. Rövanş aç.',
};

const WATCHER_SUB: Record<VulgarityLevel, string> = {
  1: 'Bu çelıncta yarışmadın, sonuç aşağıda.',
  2: 'Sen bu çelınca girmedin, sadece izledin.',
  3: 'Sen kenardan izledin, iş bitti 🍆',
};

const NO_REWARD: Record<VulgarityLevel, string> = {
  1: 'Ödül yazılmamış ama laf hakkı senin.',
  2: 'Ödül yok lan ama laf hakkı senin, kullan.',
  3: 'Ödül yazmamışlar. Olsun, elinde 🍆 var.',
};

const NO_PENALTY: Record<VulgarityLevel, string> = {
  1: 'Ceza yazılmamış. Bu sefer sadece gurur meselesi.',
  2: 'Ceza yazılmamış. Yine de yedin.',
  3: 'Ceza yazmamışlar. Yediğin yeter zaten 🍆',
};

const WAIT_SUB = (level: VulgarityLevel, winner: string): string => {
  if (level === 1) return `${winner} henüz bir şey yazmadı. Belki nazik davranıyor.`;
  if (level === 3) return `${winner} daha saplamadı. Telefonunu yakınında tut 🍆`;
  return `${winner} daha ağzını açmadı. Beklemede kal.`;
};

/* ------------------------------------------------------------------ utils */

/** Springs a block up into place once, `delay` ms after mount. */
function useRise(delay: number): Animated.Value {
  const value = useAnimatedValue(0);
  useEffect(() => {
    const animation = Animated.spring(value, {
      toValue: 1,
      delay,
      friction: 7,
      tension: 55,
      useNativeDriver: USE_NATIVE_DRIVER,
    });
    animation.start();
    return () => animation.stop();
  }, [delay, value]);
  return value;
}

function riseStyle(value: Animated.Value, distance = 28) {
  return {
    opacity: value,
    transform: [
      { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) },
      { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
    ],
  };
}

/* ----------------------------------------------------------------- screen */

export default function ResultsScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const level = useLevel();
  const me = useAuth((s) => s.me);
  const meId = me?.id ?? null;
  const tz = useTimezone();
  const toast = useToast();

  const query = useResults(id);
  // the detail query is the authority on "one taunt per loser"; it is usually
  // already cached because we arrive from the challenge screen
  const detail = useChallenge(id);
  const rematch = useRematch(id);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  const openTaunt = (to: string) => {
    router.push({ pathname: '/challenge/[id]/taunt', params: { id, to } });
  };

  const startRematch = async () => {
    try {
      const created = await rematch.mutateAsync();
      if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      toast({
        title: 'Rövanş açıldı',
        body: 'Yeni çelınc kuruldu, kankalar davet edildi.',
        kind: 'success',
      });
      router.replace({ pathname: '/challenge/[id]', params: { id: created.id } });
    } catch (error) {
      toast({ title: 'Olmadı', body: errorText(error, 'Rövanş açılamadı.'), kind: 'danger' });
    }
  };

  // a link without an id leaves the query disabled: guard before the skeleton
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Sonuç" />
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
        <Header onBack={back} title="Sonuç" />
        <Skeleton height={64} style={styles.block} />
        <Skeleton height={210} style={styles.block} />
        <Skeleton height={160} style={styles.block} />
      </Screen>
    );
  }

  if (query.isError || !query.data) {
    const err = query.error;
    const missing = err instanceof ApiError && err.status === 404;
    const early = err instanceof ApiError && (err.status === 409 || err.code === 'not_finished');
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Sonuç" />
        <EmptyState
          emoji={missing ? '🫥' : early ? '⏳' : '📡'}
          title={missing ? 'Böyle bir çelınc yok' : early ? 'Çelınc daha bitmedi' : 'Sonuç gelmedi'}
          subtitle={
            missing
              ? 'Ya silindi ya da bu çelıncın içinde değilsin.'
              : early
                ? 'Çelınc bitince sonuç burada olur.'
                : errorText(err, 'Sunucuya ulaşamadım.')
          }
          actionLabel={missing ? 'Listeye dön' : early ? 'Çelınca dön' : 'Tekrar dene'}
          onAction={() => {
            if (missing) back();
            else if (early) router.navigate({ pathname: '/challenge/[id]', params: { id } });
            else void query.refetch();
          }}
        />
      </Screen>
    );
  }

  const { challenge, standings, taunts } = query.data;
  const type: ChallengeType | undefined = getChallengeType(challenge.typeKey);
  const scoreText = (value: number) => scoreLabel({ unitTr: challenge.unit }, value);

  if (challenge.status !== 'finished') {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header onBack={back} title="Sonuç" />
        <EmptyState
          emoji={challenge.status === 'cancelled' ? '🚫' : '⏳'}
          title={challenge.status === 'cancelled' ? 'Bu çelınc iptal edildi' : 'Çelınc daha bitmedi'}
          subtitle={
            challenge.status === 'cancelled'
              ? 'Sonuç yazılmadı. İstersen yeni bir tane aç.'
              : 'Bitiş saatini bekle, sonuç o zaman yazılır.'
          }
          actionLabel="Çelınca dön"
          onAction={() => router.navigate({ pathname: '/challenge/[id]', params: { id } })}
        />
      </Screen>
    );
  }

  const players = standings.filter((p) => p.status === 'accepted');
  const ranked = [...players].sort((a, b) => a.rank - b.rank || b.days - a.days);
  const mine = standings.find((p) => p.user.id === meId) ?? null;
  const isPlayer = mine?.status === 'accepted';
  const iWon = !!meId && challenge.winnerId === meId;
  const isTie = challenge.isTie || (!challenge.winnerId && !!ranked.length);
  const winner = ranked.find((p) => p.isWinner) ?? (challenge.winnerId ? ranked.find((p) => p.user.id === challenge.winnerId) : undefined);

  // losers = everybody who played, is not me and is not the winner
  const losers = ranked.filter((p) => p.user.id !== meId && !p.isWinner);
  const taunted = new Set<string>();
  for (const row of detail.data?.canTaunt ?? []) if (row.done) taunted.add(row.toUserId);
  for (const sent of taunts) if (sent.fromUserId === meId) taunted.add(sent.toUserId);
  const pendingLosers = losers.filter((l) => !taunted.has(l.user.id));

  const received: Taunt | undefined = meId ? taunts.find((x) => x.toUserId === meId) : undefined;
  const senderOf = (taunt: Taunt): ParticipantView | undefined =>
    standings.find((p) => p.user.id === taunt.fromUserId);

  // how far behind the winner I finished / how far ahead of the runner-up I did
  const runnerUp = losers[0];
  const loserGap = winner && mine ? Math.abs(winner.score - mine.score) : 0;
  const winnerGap = mine && runnerUp ? Math.abs(mine.score - runnerUp.score) : 0;

  return (
    <Screen
      scroll
      glow
      onRefresh={() => {
        void query.refetch();
        void detail.refetch();
      }}
      refreshing={query.isRefetching}
      contentStyle={styles.content}
      bottomInset={Spacing.xxl}>
      <Header onBack={back} title={challenge.title || type?.nameTr || 'Sonuç'} />

      {iWon ? (
        <WinnerHeader level={level} />
      ) : isTie ? (
        <NeutralHeader title={TIE_TITLE[level]} subtitle={TIE_SUB[level]} emoji="🤝" />
      ) : isPlayer ? (
        <ShameHeader level={level} />
      ) : (
        <NeutralHeader
          title="ÇELINC BİTTİ"
          subtitle={WATCHER_SUB[level]}
          emoji="🏁"
        />
      )}

      {/* --------------------------------------------------------- podium */}
      {ranked.length > 0 ? (
        <Card padded={false} style={styles.podiumCard}>
          {iWon ? <Confetti /> : null}
          <Podium ranked={ranked} meId={meId} scoreText={scoreText} celebrate={iWon} />
        </Card>
      ) : null}

      {/* -------------------------------------------------- taunt received */}
      {!iWon && !isTie && isPlayer ? (
        received ? (
          <TauntBubble
            loud
            title={received.title}
            body={received.body}
            fromName={senderOf(received)?.user.displayName ?? winner?.user.displayName}
            fromEmoji={senderOf(received)?.user.avatarEmoji ?? winner?.user.avatarEmoji}
            timeLabel={relativeTime(received.createdAt)}
          />
        ) : (
          <Card edgeColor={Colors.accentDim}>
            <Text variant="title">Daha sesi çıkmadı</Text>
            <Text variant="small" muted style={styles.gap}>
              {WAIT_SUB(level, winner?.user.displayName ?? 'Kazanan')}
            </Text>
          </Card>
        )
      ) : null}

      {/* ------------------------------------------------------ standings */}
      <Card>
        <Text variant="label" style={styles.sectionLabel}>
          Final tablosu
        </Text>
        <Standings participants={standings} type={type} meId={meId} finished />
        {isPlayer && !iWon && !isTie && winner ? (
          <Text variant="small" bold color={Colors.accent} style={styles.gapLine}>
            {winner.user.displayName} ile aranda {scoreText(loserGap)} fark var.
          </Text>
        ) : null}
        {isPlayer && iWon && runnerUp ? (
          <Text variant="small" bold color={Colors.success} style={styles.gapLine}>
            En yakın takipçin {runnerUp.user.displayName}, arada {scoreText(winnerGap)} var.
          </Text>
        ) : null}
      </Card>

      {/* -------------------------------------------------- winner actions */}
      {iWon ? (
        <Card edgeColor={Colors.accent} glow>
          <Text variant="label" style={styles.sectionLabel}>
            Laf hakkı senin
          </Text>
          <Text variant="small" muted>
            {TAUNT_PROMPT[level]}
          </Text>

          <View style={styles.prize}>
            <Text variant="small">
              🎁 <Text variant="small" bold>{challenge.rewardText || NO_REWARD[level]}</Text>
            </Text>
          </View>

          {losers.length === 0 ? (
            <Text variant="small" faint style={styles.gap}>
              Kaybeden yok, mesaj gidecek kimse kalmamış.
            </Text>
          ) : (
            <View style={styles.loserList}>
              {losers.map((loser) => {
                const done = taunted.has(loser.user.id);
                return (
                  <View key={loser.user.id} style={styles.loserRow}>
                    <Avatar
                      emoji={loser.user.avatarEmoji}
                      name={loser.user.displayName}
                      size={38}
                      ring={done ? Colors.success : Colors.accentDim}
                    />
                    <View style={styles.grow}>
                      <Text variant="small" bold numberOfLines={1}>
                        {loser.user.displayName}
                      </Text>
                      <Text variant="tiny" muted numberOfLines={1}>
                        {loser.rank}. · {scoreText(loser.score)}
                      </Text>
                    </View>
                    {done ? (
                      <Chip
                        label={TAUNT_DONE_CHIP[level]}
                        icon="✅"
                        color={Colors.success}
                        size="sm"
                      />
                    ) : (
                      <Button
                        title={TAUNT_CTA[level]}
                        size="sm"
                        onPress={() => openTaunt(loser.user.id)}
                      />
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {pendingLosers.length > 1 ? (
            <Button
              title={TAUNT_ALL[level]}
              variant="yellow"
              size="lg"
              fullWidth
              icon={TAUNT_ALL_ICON[level]}
              style={styles.gap}
              onPress={() => openTaunt('all')}
            />
          ) : null}
          {losers.length > 0 && pendingLosers.length === 0 ? (
            <Text variant="small" color={Colors.success} bold style={styles.gap}>
              {TAUNT_ALL_DONE[level]}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {/* --------------------------------------------------- loser actions */}
      {!iWon && isPlayer ? (
        <Card edgeColor={isTie ? Colors.info : Colors.danger}>
          <Text variant="label" style={styles.sectionLabel}>
            {isTie ? 'Ortada kalan hesap' : 'Ceza'}
          </Text>
          {isTie ? (
            <Text variant="small" muted>
              {TIE_SUB[level]}
            </Text>
          ) : (
            <>
              <Text variant="small" color={Colors.danger}>
                💀 <Text variant="small" bold color={Colors.danger}>{challenge.penaltyText || NO_PENALTY[level]}</Text>
              </Text>
              {challenge.rewardText ? (
                <Text variant="tiny" muted style={styles.gap}>
                  Kazananın ödülü: {challenge.rewardText}
                </Text>
              ) : null}
              <Text variant="small" muted style={styles.gap}>
                {t('challenge_finished_lost', level)}
              </Text>
            </>
          )}
        </Card>
      ) : null}

      {/* -------------------------------------------------------- summary */}
      <Card>
        <Text variant="label" style={styles.sectionLabel}>
          Çelınc özeti
        </Text>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryEmoji}>{type?.emoji ?? '🎯'}</Text>
          <View style={styles.grow}>
            <Text variant="lead" numberOfLines={2}>
              {challenge.title || type?.nameTr || 'Çelınc'}
            </Text>
            <Text variant="tiny" muted numberOfLines={1}>
              {type?.nameTr ?? challenge.metricType} · {challenge.unit}
            </Text>
            <Text variant="tiny" muted numberOfLines={1}>
              {dateRange(challenge.startsAt, challenge.endsAt, tz)} · {players.length} kişi
            </Text>
            {challenge.finalizedAt ? (
              <Text variant="tiny" faint numberOfLines={1}>
                Kapanış: {relativeTime(challenge.finalizedAt)}
              </Text>
            ) : null}
          </View>
        </View>
        {isPlayer ? (
          <Button
            title={iWon || isTie ? REMATCH_WINNER[level] : t('rematch_button', level)}
            icon="🔁"
            size="xl"
            fullWidth
            style={styles.gap}
            loading={rematch.isPending}
            onPress={() => void startRematch()}
          />
        ) : null}
        <Button
          title="Çelınca dön"
          variant="ghost"
          size="md"
          fullWidth
          style={styles.gap}
          onPress={() => router.navigate({ pathname: '/challenge/[id]', params: { id } })}
        />
      </Card>
    </Screen>
  );
}

/* ----------------------------------------------------------------- pieces */

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

function WinnerHeader({ level }: { level: VulgarityLevel }) {
  const rise = useRise(0);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  return (
    <Animated.View style={[styles.headline, riseStyle(rise, 20)]}>
      <Text variant="giant" color={Colors.yellow} center adjustsFontSizeToFit numberOfLines={1}>
        {WIN_TITLE[level]}
      </Text>
      <Text variant="lead" muted center>
        {t('challenge_finished_won', level)}
      </Text>
    </Animated.View>
  );
}

function ShameHeader({ level }: { level: VulgarityLevel }) {
  const rise = useRise(0);
  return (
    <Animated.View style={[styles.headline, riseStyle(rise, 20)]}>
      <Text variant="giant" color={Colors.accent} center adjustsFontSizeToFit numberOfLines={2}>
        {t('shame_screen_title', level)}
      </Text>
      <Text variant="lead" muted center>
        {t('shame_screen_subtitle', level)}
      </Text>
    </Animated.View>
  );
}

function NeutralHeader({ title, subtitle, emoji }: { title: string; subtitle: string; emoji: string }) {
  const rise = useRise(0);
  return (
    <Animated.View style={[styles.headline, riseStyle(rise, 20)]}>
      <Text style={styles.neutralEmoji}>{emoji}</Text>
      <Text variant="big" center>
        {title}
      </Text>
      <Text variant="small" muted center>
        {subtitle}
      </Text>
    </Animated.View>
  );
}

/* podium ------------------------------------------------------------------ */

const PLACE_COLOR = [Colors.yellow, Colors.textMuted, Colors.accentDim];
const PLACE_HEIGHT = [104, 78, 60];
const PLACE_AVATAR = [72, 52, 48];
const MEDALS = ['🥇', '🥈', '🥉'];

function Podium({
  ranked,
  meId,
  scoreText,
  celebrate,
}: {
  ranked: ParticipantView[];
  meId: string | null;
  scoreText: (value: number) => string;
  celebrate: boolean;
}) {
  const first = ranked[0];
  const second = ranked[1];
  const third = ranked[2];
  const rest = ranked.length - 3;

  return (
    <View style={styles.podium}>
      <View style={styles.podiumRow}>
        {second ? (
          <PodiumColumn participant={second} place={2} meId={meId} scoreText={scoreText} delay={80} />
        ) : (
          <View style={styles.grow} />
        )}
        {first ? (
          <PodiumColumn
            participant={first}
            place={1}
            meId={meId}
            scoreText={scoreText}
            delay={260}
            celebrate={celebrate}
          />
        ) : null}
        {third ? (
          <PodiumColumn participant={third} place={3} meId={meId} scoreText={scoreText} delay={170} />
        ) : (
          <View style={styles.grow} />
        )}
      </View>
      {rest > 0 ? (
        <Text variant="tiny" faint center style={styles.podiumRest}>
          ve arkadan gelen {rest} kişi daha
        </Text>
      ) : null}
    </View>
  );
}

function PodiumColumn({
  participant,
  place,
  meId,
  scoreText,
  delay,
  celebrate,
}: {
  participant: ParticipantView;
  place: 1 | 2 | 3;
  meId: string | null;
  scoreText: (value: number) => string;
  delay: number;
  celebrate?: boolean;
}) {
  const rise = useRise(delay);
  const index = place - 1;
  const color = PLACE_COLOR[index] ?? Colors.textMuted;
  const isMe = participant.user.id === meId;
  // the pedestal is a visual position, the medal and the number are the real rank
  // (a tie hands out two rank 1s)
  const medal = participant.rank <= 3 ? MEDALS[participant.rank - 1] : '🎖️';

  return (
    <Animated.View style={[styles.column, riseStyle(rise, 40)]}>
      {participant.isWinner ? <Crown animate={!!celebrate} /> : <Text style={styles.medal}>{medal}</Text>}
      <Avatar
        emoji={participant.user.avatarEmoji}
        name={participant.user.displayName}
        size={PLACE_AVATAR[index] ?? 48}
        ring={color}
      />
      <Text variant="tiny" bold numberOfLines={1} center style={styles.columnName}>
        {participant.user.displayName}
        {isMe ? ' (sen)' : ''}
      </Text>
      <Text variant="micro" color={color} numberOfLines={1} center>
        {scoreText(participant.score)}
      </Text>
      <View
        style={[
          styles.pedestal,
          { height: PLACE_HEIGHT[index] ?? 60, borderColor: color },
          place === 1 && styles.pedestalFirst,
        ]}>
        <Text variant={place === 1 ? 'huge' : 'big'} color={color}>
          {participant.rank}
        </Text>
      </View>
    </Animated.View>
  );
}

function Crown({ animate }: { animate: boolean }) {
  const value = useAnimatedValue(0);

  useEffect(() => {
    if (!animate) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: USE_NATIVE_DRIVER,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [animate, value]);

  return (
    <Animated.Text
      style={[
        styles.crown,
        { transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] },
      ]}>
      👑
    </Animated.Text>
  );
}

const CONFETTI_EMOJI = ['🎉', '🔥', '🍆', '💥', '🏆', '✨', '🎊', '👑'];

/** Cheap one-shot burst above the podium — Animated only, no extra dependency. */
function Confetti() {
  // `useState` rather than a ref: the compiler forbids reading a ref during
  // render, and these values only ever need to be created once.
  const [pieces] = useState(() =>
    CONFETTI_EMOJI.map((emoji, index) => ({
      emoji,
      key: `${emoji}-${index}`,
      delay: index * 90,
      value: new Animated.Value(0),
    }))
  );

  useEffect(() => {
    const group = Animated.parallel(
      pieces.map((piece) =>
        Animated.timing(piece.value, {
          toValue: 1,
          duration: 1500,
          delay: piece.delay,
          easing: Easing.out(Easing.quad),
          useNativeDriver: USE_NATIVE_DRIVER,
        })
      )
    );
    group.start();
    return () => group.stop();
  }, [pieces]);

  return (
    <View pointerEvents="none" style={styles.confetti}>
      {pieces.map((piece) => (
        <Animated.Text
          key={piece.key}
          style={[
            styles.confettiPiece,
            {
              opacity: piece.value.interpolate({
                inputRange: [0, 0.15, 0.75, 1],
                outputRange: [0, 1, 1, 0],
              }),
              transform: [
                {
                  translateY: piece.value.interpolate({
                    inputRange: [0, 1],
                    outputRange: [16, -46],
                  }),
                },
                {
                  scale: piece.value.interpolate({
                    inputRange: [0, 0.3, 1],
                    outputRange: [0.4, 1.15, 0.9],
                  }),
                },
              ],
            },
          ]}>
          {piece.emoji}
        </Animated.Text>
      ))}
    </View>
  );
}

/* ------------------------------------------------------------------ dates */

/** "1 Eylül – 8 Eylül" in the reader's timezone. */
function dateRange(startsAt: string, endsAt: string, tz: string): string {
  const startKey = safeDayKey(startsAt, tz);
  const endKey = safeDayKey(endsAt, tz);
  if (!startKey || !endKey) return '';
  if (startKey === endKey) return formatDayKey(startKey);
  return `${formatDayKey(startKey)} – ${formatDayKey(endKey)}`;
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.md },
  block: { borderRadius: Radius.lg },
  grow: { flex: 1 },
  gap: { marginTop: Spacing.md },

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

  headline: { alignItems: 'center', gap: Spacing.xs, paddingTop: Spacing.sm },
  neutralEmoji: { fontSize: 40 },

  podiumCard: { paddingHorizontal: Spacing.md, paddingTop: Spacing.md, paddingBottom: Spacing.lg },
  podium: { gap: Spacing.sm },
  podiumRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: Spacing.sm },
  podiumRest: { marginTop: Spacing.xs },
  column: { flex: 1, alignItems: 'center', gap: 4 },
  columnName: { maxWidth: '100%' },
  medal: { fontSize: 20 },
  crown: { fontSize: 26 },
  pedestal: {
    alignSelf: 'stretch',
    marginTop: Spacing.sm,
    borderRadius: Radius.md,
    borderWidth: 1,
    backgroundColor: Colors.surfaceHigh,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pedestalFirst: { backgroundColor: Colors.yellowDim },

  confetti: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 30,
    paddingHorizontal: Spacing.sm,
  },
  confettiPiece: { fontSize: 18 },

  sectionLabel: { marginBottom: Spacing.md },
  gapLine: { marginTop: Spacing.md },
  prize: { marginTop: Spacing.md },

  loserList: { marginTop: Spacing.lg, gap: Spacing.md },
  loserRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },

  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  summaryEmoji: { fontSize: 34 },
});
