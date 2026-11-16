import {
  BADGES,
  LIMITS,
  evaluateBadges,
  t,
  BADGE_FAMILIES,
  BADGE_FAMILY_LABELS_TR,
  badgeLadder,
  badgeStatKey,
  badgeTarget,
  badgeTitle,
  type BadgeDef,
  type BadgeFamily,
  type BadgeRung,
  type LeaderboardEntry,
  type UserStats,
  type VulgarityLevel,
} from '@koydum/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { Loading, Skeleton } from '@/components/Loading';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { Stat } from '@/components/Stat';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useFriends, useLeaderboard, useUpdateMe } from '@/hooks/queries';
import { usePullRefresh } from '@/hooks/usePullRefresh';
import { ApiError } from '@/lib/api';
import { qk } from '@/lib/query';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, FontSize, Radius, Spacing } from '@/theme';
import { formatNumber } from '@/utils/format';

/** Coming back to the tab refetches a board older than this (the app's staleTime). */
const PROFILE_FRESH_MS = 20_000;

/** Curated avatar set — loud, friendly, and safe to show in a group chat. */
const AVATAR_EMOJI = [
  '🍆', '🔥', '💀', '👑', '😎', '🤡', '👻', '🥷',
  '🐐', '🦍', '🐺', '🦅', '🐍', '🦖', '🐓', '🦈',
  '⚡', '💣', '🎯', '🏆', '🚀', '🧿', '🧠', '💪',
  '🏃', '🧘', '☕', '🍕', '🥶', '😈', '🤖', '🫡',
];

const LEVEL_CHIP: Record<VulgarityLevel, { label: string; emoji: string }> = {
  1: { label: 'Nazik', emoji: '🙂' },
  2: { label: 'Delikanlı', emoji: '😏' },
  3: { label: 'Ağır Abi', emoji: '🍆' },
};

/**
 * Turkish sentence for one badge stat, e.g. wins >= 5 → "5 çelınc kazan".
 * Keyed by string so an unknown stat coming from the catalog degrades gracefully.
 */
const RULE_TEXT: Record<string, (n: number) => string> = {
  wins: (n) => `${formatNumber(n)} çelınc kazan`,
  losses: (n) => `${formatNumber(n)} çelınc kaybet`,
  ties: (n) => `${formatNumber(n)} kez berabere kal`,
  // the ladder reads the phone's count alone (a day typed with "Beyan et" can
  // still fall to an itiraz, a badge never goes back): somebody who typed
  // 25.000 sat at 0/15.000 with nothing saying why
  stepsSingleDayMax: (n) => `Tek günde ${formatNumber(n)} adım at (telefonun saydığı)`,
  // minutes, like the progress under it and the badge itself: "50sa" over
  // "1.280/3.000" left the reader to work out that 3.000 was the 50 hours
  focusTotalMinutes: (n) => `Toplam ${formatNumber(n)} dakika odaklan`,
  checkinsStreakMax: (n) => `${formatNumber(n)} gün üst üste zamanında kalk`,
  disputesWon: (n) => `${formatNumber(n)} itiraz kazan`,
  challengesPlayed: (n) => `${formatNumber(n)} çelınca katıl`,
  pokesSent: (n) => `${formatNumber(n)} kanka dürt`,
  // only a rematch of one you lost counts: "3 rövanş kazan" promised the rung
  // to somebody winning rematches of his own wins, stuck at 0/3
  revengeWins: (n) => `Kaybettiğin ${formatNumber(n)} çelıncın rövanşını al`,
};

/** What the next rung is asking for, in Turkish. */
function ruleHint(badge: BadgeDef): string {
  const key = badgeStatKey(badge);
  const say = key ? RULE_TEXT[key] : undefined;
  return say ? say(badgeTarget(badge)) : badge.descriptionTr;
}

/** Reads a stat the server may or may not report yet. */
function statValue(stats: UserStats, key: string): number {
  const value = (stats as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : 0;
}

/**
 * Tapping a rung explains what it takes and, where a çelınc type answers that,
 * opens the wizard with the type already chosen.
 */
const BADGE_HOWTO: Record<
  BadgeFamily,
  {
    how: string;
    /** in place of `how` at level 1, where it is said in level-2 words */
    howPolite?: string;
    cta: string;
    href: { pathname: string; params?: Record<string, string> };
  }
> = {
  koyus: {
    how: 'Çelınc kazandıkça yükselir. Herhangi bir türde, kim kazanırsa o koyar.',
    howPolite: 'Çelınc kazandıkça yükselir. Hangi türde olursa olsun, her galibiyet sayılır.',
    cta: 'Çelınc aç',
    href: { pathname: '/(app)/challenge/new' },
  },
  yiyis: {
    how: 'Kaybettikçe yükselir. Kimse bunu istemez ama herkes bir yerden başlar.',
    cta: 'Çelınc aç',
    href: { pathname: '/(app)/challenge/new' },
  },
  adim: {
    how: 'Tek günde attığın adıma bakar. Bir adım çelıncı açıp yürümen yeter, telefon sayıyor.',
    cta: 'Adım çelıncı aç',
    href: { pathname: '/(app)/challenge/new', params: { type: 'adim_yarisi' } },
  },
  odak: {
    how: 'Odak seanslarında biriktirdiğin toplam dakikaya bakar. Telefonu bırak, sayaç çalışsın.',
    cta: 'Odak çelıncı aç',
    href: { pathname: '/(app)/challenge/new', params: { type: 'odak_seansi' } },
  },
  erken: {
    how: 'Üst üste kaç sabah zamanında check-in yaptığına bakar: Erken Kalkan Koyar ya da Yatak Toplama Sabahı. Erken Yatma Sözü\'nün geceleri buraya sayılmaz.',
    cta: 'Erken kalkma çelıncı aç',
    href: { pathname: '/(app)/challenge/new', params: { type: 'erken_kus' } },
  },
  itiraz: {
    how: 'Bir kankanın şüpheli girişine itiraz et; itirazı çoğunluk kabul ederse sayılır.',
    cta: 'Çelınclara bak',
    href: { pathname: '/(app)/(tabs)' },
  },
  rovans: {
    how: 'Kaybettiğin bir çelıncın sonuç ekranından rövanş iste ve bu sefer kazan.',
    cta: 'Kaybettiklerine bak',
    // straight to the losses: those are the ones a rövanş can be asked from
    href: { pathname: '/history', params: { show: 'lost' } },
  },
};

/**
 * A ladder's name. Two are named in level-2 words ("Koyuş", "Yiyiş"); a
 * "Nazik" reader gets what they count, as the score tiles above say it.
 */
function familyLabel(family: BadgeFamily, level: VulgarityLevel): string {
  if (level === 1 && family === 'koyus') return 'Galibiyet';
  if (level === 1 && family === 'yiyis') return 'Yenilgi';
  return BADGE_FAMILY_LABELS_TR[family];
}

/**
 * One rung. Earned rungs say what they are; the single locked one says what it
 * costs and how close you are — the rungs above it are not drawn at all, so
 * the ladder grows as you climb instead of greeting a new user with a wall of
 * grey squares.
 */
function BadgeTile({ rung, onPress }: { rung: BadgeRung; onPress: (rung: BadgeRung) => void }) {
  const { badge, earned } = rung;
  const title = badgeTitle(badge, useLevel());
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(rung)}
      style={({ pressed }) => [
        styles.badge,
        earned ? styles.badgeOn : styles.badgeOff,
        pressed && styles.badgePressed,
      ]}>
      <Text style={[styles.badgeEmoji, !earned && styles.dim]}>{title.emoji}</Text>
      <Text
        variant="tiny"
        bold
        center
        numberOfLines={2}
        color={earned ? Colors.yellow : Colors.textFaint}>
        {title.name}
      </Text>
      {earned ? (
        <Text variant="micro" center muted numberOfLines={3}>
          {badge.descriptionTr}
        </Text>
      ) : (
        <>
          <Text variant="micro" center faint numberOfLines={3}>
            {ruleHint(badge)}
          </Text>
          <Text variant="micro" center color={Colors.accent}>
            {formatNumber(Math.min(rung.current, rung.target))}/{formatNumber(rung.target)}
          </Text>
          <ProgressBar
            value={rung.progress}
            color={Colors.accentDim}
            track={Colors.surfaceHigh}
            height={4}
            style={styles.badgeBar}
          />
        </>
      )}
    </Pressable>
  );
}

export default function ProfileScreen() {
  const me = useAuth((s) => s.me);
  const refreshMe = useAuth((s) => s.refreshMe);
  const logout = useAuth((s) => s.logout);
  const level = useLevel();
  const toast = useToast();

  const friends = useFriends();
  const leaderboard = useLeaderboard();
  const updateMe = useUpdateMe();

  const pull = usePullRefresh(() => Promise.all([refreshMe(), friends.refetch(), leaderboard.refetch()]));
  const queryClient = useQueryClient();

  // The tab stays mounted and nothing refetches on focus (lib/query), and `me`
  // only moves on foreground through the step and screen-time sync, which a
  // phone without those permissions (and the web) never runs: a friend's finish
  // left Sıralama in the old order, a fresh rozet stayed locked.
  useFocusEffect(() => {
    const state = queryClient.getQueryState(qk.leaderboard);
    if (!state || state.fetchStatus !== 'idle') return;
    // from the last answer, good or bad: a server that is down is asked at most every 20 s
    const lastTry = Math.max(state.dataUpdatedAt, state.errorUpdatedAt);
    if (Date.now() - lastTry > PROFILE_FRESH_MS) {
      // the Karne and the board are both computeUserStats: read them at the same moment
      void queryClient.refetchQueries({ queryKey: qk.leaderboard });
      void refreshMe();
    }
  });

  const [emojiOpen, setEmojiOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [openRung, setOpenRung] = useState<BadgeRung | null>(null);

  if (!me) {
    return (
      <Screen>
        <Loading label="Profil yükleniyor…" />
      </Screen>
    );
  }

  // the server owns these, but a half-filled payload must not blank the screen
  const stats = (me.stats ?? {}) as UserStats;
  const earned = new Set<string>([...(me.badges ?? []), ...evaluateBadges(stats)]);
  const earnedCount = BADGES.filter((badge) => earned.has(badge.key)).length;
  const ladder = badgeLadder(stats, [...earned]);
  const openTitle = openRung ? badgeTitle(openRung.badge, level) : null;
  const friendCount = friends.data?.friends.length ?? 0;

  const saveField = (
    body: Parameters<typeof updateMe.mutate>[0],
    okMessage: string,
    onDone?: () => void
  ) => {
    updateMe.mutate(body, {
      onSuccess: () => {
        toast({ title: okMessage, kind: 'success' });
        onDone?.();
      },
      onError: (err) =>
        toast({
          title: 'Kaydedilemedi',
          body: err instanceof ApiError ? err.message : undefined,
          kind: 'danger',
        }),
    });
  };

  const chooseEmoji = (emoji: string) => {
    setEmojiOpen(false);
    if (emoji === me.avatarEmoji) return;
    saveField({ avatarEmoji: emoji }, 'Surat değişti');
  };

  const openNameSheet = () => {
    setNameDraft(me.displayName);
    setNameError(null);
    setNameOpen(true);
  };

  const saveName = () => {
    const next = nameDraft.trim();
    if (next.length < 2) {
      setNameError('En az 2 karakter olsun.');
      return;
    }
    if (next.length > LIMITS.DISPLAY_NAME_MAX) {
      setNameError(`En fazla ${LIMITS.DISPLAY_NAME_MAX} karakter.`);
      return;
    }
    if (next === me.displayName) {
      setNameOpen(false);
      return;
    }
    saveField({ displayName: next }, 'İsim kaydedildi', () => setNameOpen(false));
  };

  const copyInvite = async () => {
    try {
      await Clipboard.setStringAsync(me.inviteCode);
      toast({
        title: 'Kod kopyalandı',
        body: level === 1 ? 'Arkadaşına gönderebilirsin.' : 'At kankalara, gelsinler.',
        kind: 'success',
      });
    } catch {
      toast({ title: 'Kopyalanamadı', body: me.inviteCode, kind: 'danger' });
    }
  };

  const doLogout = async () => {
    setLogoutOpen(false);
    // `logout` drops the react-query cache itself, so every exit path (here,
    // Ayarlar, a 401) leaves the same clean slate for the next account
    await logout();
  };

  return (
    <Screen scroll onRefresh={pull.onRefresh} refreshing={pull.refreshing} glow bottomInset={Spacing.xxl}>
      {/* ---------------------------------------------------------- header */}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Suratını değiştir"
          onPress={() => setEmojiOpen(true)}
          style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
          <Avatar emoji={me.avatarEmoji} name={me.displayName} size={92} ring={Colors.accent} />
          <View style={styles.avatarEdit}>
            <Text variant="micro" color={Colors.white}>
              ✏️
            </Text>
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="İsmini değiştir"
          onPress={openNameSheet}
          style={({ pressed }) => [styles.nameRow, pressed && styles.pressed]}>
          <Text variant="big" numberOfLines={1}>
            {me.displayName}
          </Text>
          <Text variant="small" muted>
            ✏️
          </Text>
        </Pressable>

        <Text variant="small" muted>
          @{me.username}
        </Text>

        <Chip
          label={(LEVEL_CHIP[me.vulgarityMax] ?? LEVEL_CHIP[2]).label}
          icon={(LEVEL_CHIP[me.vulgarityMax] ?? LEVEL_CHIP[2]).emoji}
          color={Colors.yellow}
          size="sm"
          onPress={() => router.push('/settings')}
        />
      </View>

      {/* ----------------------------------------------------- invite code */}
      <Card style={styles.inviteCard}>
        <View style={styles.inviteRow}>
          <View style={styles.inviteText}>
            <Text variant="label">Davet kodun</Text>
            <Text variant="title" style={styles.inviteCode} numberOfLines={1}>
              {me.inviteCode}
            </Text>
          </View>
          <Button title="Kopyala" size="sm" variant="secondary" icon="📋" onPress={() => void copyInvite()} />
        </View>
      </Card>

      {/* ----------------------------------------------------------- stats */}
      <View style={styles.section}>
        <Text variant="label">Karne</Text>
        <View style={styles.statRow}>
          {/* "Nazik" reads the same numbers without the eggplant, as the recap card does */}
          <Stat
            label={level === 1 ? 'Galibiyet' : 'Koydum'}
            value={statValue(stats, 'wins')}
            emoji={level === 1 ? '🏆' : '🍆'}
            color={Colors.success}
          />
          <Stat
            label={level === 1 ? 'Yenilgi' : 'Yedim'}
            value={statValue(stats, 'losses')}
            emoji="😵"
            color={Colors.danger}
          />
          <Stat label="Berabere" value={statValue(stats, 'ties')} emoji="🤝" />
        </View>
        <View style={styles.statRow}>
          <Stat label="Kanka" value={friendCount} emoji="🫂" color={Colors.info} />
          <Stat
            label="Çelınc"
            value={statValue(stats, 'challengesPlayed')}
            emoji="⚔️"
            color={Colors.accent}
          />
          <Stat
            label="Rövanş"
            value={statValue(stats, 'revengeWins')}
            emoji="🔁"
            color={Colors.yellow}
          />
        </View>
      </View>

      {/* --------------------------------------------------------- ladders */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text variant="label">Rozetler</Text>
          <Text variant="micro" faint>
            {earnedCount}/{BADGES.length}
          </Text>
        </View>
        {BADGE_FAMILIES.map((family) => {
          const rungs = ladder.filter((rung) => rung.badge.family === family);
          if (rungs.length === 0) return null;
          const climbed = rungs.filter((rung) => rung.earned).length;
          const total = BADGES.filter((badge) => badge.family === family).length;
          return (
            <View key={family} style={styles.ladder}>
              <View style={styles.sectionHead}>
                {/* `upper` capitalises through upperTr: Hermes has no reliable
                    toLocaleUpperCase('tr-TR'), and "GALİBİYET" needs its dots */}
                <Text variant="micro" color={climbed > 0 ? Colors.yellow : Colors.textFaint} bold upper>
                  {familyLabel(family, level)}
                </Text>
                <Text variant="micro" faint>
                  seviye {climbed}/{total}
                </Text>
              </View>
              <View style={styles.badgeGrid}>
                {rungs.map((rung) => (
                  <BadgeTile key={rung.badge.key} rung={rung} onPress={setOpenRung} />
                ))}
              </View>
            </View>
          );
        })}
      </View>

      {/* ----------------------------------------------------- leaderboard */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text variant="label">Sıralama</Text>
          <Text variant="micro" faint>
            {level === 1 ? 'en çok kazananlar' : 'en çok koyanlar'}
          </Text>
        </View>
        <Card padded={false} style={styles.boardCard}>
          <Leaderboard
            rows={leaderboard.data ?? []}
            meId={me.id}
            level={level}
            loading={leaderboard.isLoading}
            error={leaderboard.error}
            onRetry={() => void leaderboard.refetch()}
          />
        </Card>
      </View>

      {/* --------------------------------------------------------- actions */}
      <View style={styles.actions}>
        <Button
          title="Ayarlar"
          icon="⚙️"
          variant="secondary"
          size="lg"
          fullWidth
          onPress={() => router.push('/settings')}
        />
        <Button
          title="Çıkış yap"
          icon="🚪"
          variant="ghost"
          size="md"
          fullWidth
          onPress={() => setLogoutOpen(true)}
        />
      </View>

      {/* ---------------------------------------------------------- sheets */}
      <Sheet visible={emojiOpen} onClose={() => setEmojiOpen(false)} title="Suratını seç">
        <View style={styles.emojiGrid}>
          {AVATAR_EMOJI.map((emoji) => {
            const active = emoji === me.avatarEmoji;
            return (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => chooseEmoji(emoji)}
                style={({ pressed }) => [
                  styles.emojiCell,
                  active && styles.emojiCellActive,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.emojiBig}>{emoji}</Text>
              </Pressable>
            );
          })}
        </View>
      </Sheet>

      <Sheet visible={nameOpen} onClose={() => setNameOpen(false)} title="İsmin" scroll={false}>
        <Input
          label="Görünen ad"
          value={nameDraft}
          onChangeText={(text) => {
            setNameDraft(text);
            setNameError(null);
          }}
          maxLength={LIMITS.DISPLAY_NAME_MAX}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={saveName}
          error={nameError}
          hint={`Kankaların seni böyle görecek. En fazla ${LIMITS.DISPLAY_NAME_MAX} karakter.`}
        />
        <Button
          title="Kaydet"
          size="lg"
          fullWidth
          loading={updateMe.isPending}
          onPress={saveName}
        />
      </Sheet>

      <Sheet
        visible={!!openRung}
        onClose={() => setOpenRung(null)}
        title={openTitle ? `${openTitle.emoji} ${openTitle.name}` : ''}
        scroll={false}>
        {openRung ? (
          <View style={styles.rungSheet}>
            <Text variant="small" muted>
              {familyLabel(openRung.badge.family, level)} merdiveni · {openRung.badge.tier}. basamak
            </Text>
            <Text variant="body">
              {(level === 1 && BADGE_HOWTO[openRung.badge.family].howPolite) || BADGE_HOWTO[openRung.badge.family].how}
            </Text>
            {openRung.earned ? (
              <Text variant="small" color={Colors.yellow}>
                ✓ {openRung.badge.descriptionTr}
              </Text>
            ) : (
              <>
                <Text variant="small" color={Colors.accent}>
                  {ruleHint(openRung.badge)} · {formatNumber(Math.min(openRung.current, openRung.target))}/
                  {formatNumber(openRung.target)}
                </Text>
                <ProgressBar
                  value={openRung.progress}
                  color={Colors.accent}
                  track={Colors.surfaceHigh}
                  height={6}
                />
              </>
            )}
            <Button
              title={BADGE_HOWTO[openRung.badge.family].cta}
              icon="🔥"
              fullWidth
              onPress={() => {
                const target = BADGE_HOWTO[openRung.badge.family].href;
                setOpenRung(null);
                router.push(target);
              }}
            />
          </View>
        ) : null}
      </Sheet>

      <Sheet visible={logoutOpen} onClose={() => setLogoutOpen(false)} title="Çıkış" scroll={false}>
        <Text variant="body" muted>
          {t('logout_confirm', level)}
        </Text>
        <View style={styles.sheetActions}>
          <Button
            title="Vazgeç"
            variant="secondary"
            size="lg"
            style={styles.sheetButton}
            onPress={() => setLogoutOpen(false)}
          />
          <Button
            title="Çıkış yap"
            variant="danger"
            size="lg"
            style={styles.sheetButton}
            onPress={() => void doLogout()}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

function Leaderboard({
  rows,
  meId,
  level,
  loading,
  error,
  onRetry,
}: {
  rows: LeaderboardEntry[];
  meId: string;
  level: VulgarityLevel;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.boardLoading}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={34} />
        ))}
      </View>
    );
  }

  // A refetch that fails keeps the last board (TanStack keeps `data`): the tab
  // refetches on focus and after a finish, and a sleeping server must not swap
  // the board it showed a minute ago for an error.
  if (error && rows.length === 0) {
    return (
      <View style={styles.boardMessage}>
        <Text variant="small" muted center>
          {error instanceof ApiError ? error.message : 'Sıralama gelmedi.'}
        </Text>
        <Button title="Tekrar dene" size="sm" variant="ghost" onPress={onRetry} />
      </View>
    );
  }

  if (rows.length === 0) {
    return (
      <View style={styles.boardMessage}>
        <Text variant="small" muted center>
          Henüz sıralama yok. Bir çelınc bitince burası dolar.
        </Text>
      </View>
    );
  }

  const top = rows.slice(0, 5);
  const mine = rows.find((row) => row.user.id === meId);
  const visible = mine && !top.some((row) => row.user.id === meId) ? [...top, mine] : top;

  return (
    <View>
      {error ? (
        <Text variant="micro" faint center style={styles.boardStale}>
          Güncellenemedi, son gelen sıralama bu.
        </Text>
      ) : null}
      {visible.map((row, index) => {
        const isMe = row.user.id === meId;
        const gap = mine && index === visible.length - 1 && visible.length > top.length;
        return (
          <View key={row.user.id}>
            {gap ? <Text style={styles.boardGap}>⋯</Text> : null}
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                isMe ? undefined : router.push({ pathname: '/user/[id]', params: { id: row.user.id } })
              }
              style={({ pressed }) => [
                styles.boardRow,
                isMe && styles.boardRowMe,
                pressed && !isMe && styles.pressed,
              ]}>
              <Text variant="small" bold color={rankColor(row.rank)} style={styles.boardRank}>
                {row.rank}
              </Text>
              <Avatar emoji={row.user.avatarEmoji} name={row.user.displayName} size={30} />
              <Text variant="small" bold={isMe} numberOfLines={1} style={styles.boardName}>
                {row.user.displayName}
              </Text>
              {isMe ? <Chip label="SEN" color={Colors.accent} filled size="sm" /> : null}
              <View style={styles.boardWins}>
                <Text variant="small" bold color={Colors.success}>
                  {formatNumber(row.wins)}
                </Text>
                <Text variant="micro" faint>
                  {level === 1 ? 'galibiyet' : 'koyuş'}
                </Text>
              </View>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function rankColor(rank: number): string {
  if (rank === 1) return Colors.yellow;
  if (rank === 2) return Colors.text;
  if (rank === 3) return Colors.accent;
  return Colors.textMuted;
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.lg, paddingBottom: Spacing.lg },
  pressed: { opacity: 0.75 },
  avatarEdit: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, maxWidth: '100%' },

  inviteCard: { marginBottom: Spacing.xl },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  inviteText: { flex: 1, gap: 2 },
  inviteCode: { letterSpacing: 2, color: Colors.yellow },

  section: { gap: Spacing.sm, marginBottom: Spacing.xl },
  ladder: { gap: Spacing.sm, marginTop: Spacing.md },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statRow: { flexDirection: 'row', gap: Spacing.sm },

  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  badge: {
    flexBasis: '48%',
    flexGrow: 1,
    borderRadius: Radius.md,
    borderWidth: 1,
    padding: Spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  badgeOn: { backgroundColor: Colors.surface, borderColor: Colors.yellowDim },
  badgePressed: { opacity: 0.8 },
  rungSheet: { gap: Spacing.md },
  badgeOff: { backgroundColor: Colors.bg, borderColor: Colors.border },
  badgeEmoji: { fontSize: 26 },
  dim: { opacity: 0.35 },
  badgeBar: { marginTop: Spacing.xs },

  boardCard: { paddingVertical: Spacing.xs },
  boardLoading: { padding: Spacing.md, gap: Spacing.sm },
  boardMessage: { padding: Spacing.lg, alignItems: 'center', gap: Spacing.sm },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  boardRowMe: { backgroundColor: Colors.surfaceHigh },
  boardRank: { width: 22, textAlign: 'center' },
  boardName: { flex: 1 },
  boardWins: { alignItems: 'flex-end' },
  boardGap: { color: Colors.textFaint, textAlign: 'center', fontSize: FontSize.tiny },
  boardStale: { paddingTop: Spacing.sm, paddingHorizontal: Spacing.md },

  actions: { gap: Spacing.md, marginBottom: Spacing.xl },

  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, paddingBottom: Spacing.md },
  emojiCell: {
    width: 56,
    height: 56,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiCellActive: { borderColor: Colors.accent, backgroundColor: Colors.surfaceHigh },
  emojiBig: { fontSize: 28 },

  sheetActions: { flexDirection: 'row', gap: Spacing.md },
  sheetButton: { flex: 1 },
});
