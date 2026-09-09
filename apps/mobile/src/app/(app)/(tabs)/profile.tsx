import {
  BADGES,
  LIMITS,
  evaluateBadges,
  t,
  type BadgeDef,
  type LeaderboardEntry,
  type UserStats,
  type VulgarityLevel,
} from '@koydum/shared';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
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
import { ApiError } from '@/lib/api';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, FontSize, Radius, Spacing } from '@/theme';
import { formatMinutes, formatNumber } from '@/utils/format';

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
  tauntsSent: (n) => `${formatNumber(n)} laf sok`,
  tauntsReceived: (n) => `${formatNumber(n)} laf ye`,
  stepsSingleDayMax: (n) => `Tek günde ${formatNumber(n)} adım at`,
  focusTotalMinutes: (n) => `Toplam ${formatMinutes(n)} odaklan`,
  checkinsStreakMax: (n) => `${formatNumber(n)} gün üst üste zamanında kalk`,
  disputesWon: (n) => `${formatNumber(n)} itiraz kazan`,
  challengesPlayed: (n) => `${formatNumber(n)} çelınca katıl`,
  pokesSent: (n) => `${formatNumber(n)} kanka dürt`,
  revengeWins: (n) => `${formatNumber(n)} rövanş kazan`,
};

const CLAUSE = /^([a-zA-Z_]+)\s*(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/;

interface RuleClause {
  key: string;
  target: number;
}

function parseRule(rule: string): RuleClause[] {
  const clauses: RuleClause[] = [];
  for (const raw of rule.split('&&')) {
    const match = CLAUSE.exec(raw.trim());
    if (!match) continue;
    const key = match[1];
    if (!RULE_TEXT[key]) continue;
    clauses.push({ key, target: Number(match[3]) });
  }
  return clauses;
}

/** "wins>=5 && tauntsSent>=1" → "5 çelınc kazan + 1 laf sok" */
function ruleHint(badge: BadgeDef): string {
  const clauses = parseRule(badge.rule);
  if (clauses.length === 0) return badge.descriptionTr;
  return clauses.map((clause) => RULE_TEXT[clause.key](clause.target)).join(' + ');
}

/** Reads a stat the server may or may not report yet. */
function statValue(stats: UserStats, key: string): number {
  const value = (stats as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : 0;
}

/** 0..1 progress towards the badge (the least-complete clause wins). */
function ruleProgress(badge: BadgeDef, stats: UserStats): number {
  const clauses = parseRule(badge.rule);
  if (clauses.length === 0) return 0;
  let worst = 1;
  for (const clause of clauses) {
    const ratio = clause.target > 0 ? statValue(stats, clause.key) / clause.target : 1;
    worst = Math.min(worst, ratio);
  }
  return Math.max(0, Math.min(1, worst));
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

  const [refreshing, setRefreshing] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);

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
  const friendCount = friends.data?.friends.length ?? 0;

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([refreshMe(), friends.refetch(), leaderboard.refetch()]).finally(() =>
      setRefreshing(false)
    );
  };

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
    <Screen scroll onRefresh={refresh} refreshing={refreshing} glow bottomInset={Spacing.xxl}>
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
          <Stat label="Koydum" value={statValue(stats, 'wins')} emoji="🍆" color={Colors.success} />
          <Stat label="Yedin" value={statValue(stats, 'losses')} emoji="😵" color={Colors.danger} />
          <Stat label="Berabere" value={statValue(stats, 'ties')} emoji="🤝" />
        </View>
        <View style={styles.statRow}>
          <Stat label="Kanka" value={friendCount} emoji="🫂" color={Colors.info} />
          <Stat
            label="Attığın laf"
            value={statValue(stats, 'tauntsSent')}
            emoji="🗣️"
            color={Colors.accent}
          />
          <Stat
            label="Yediğin laf"
            value={statValue(stats, 'tauntsReceived')}
            emoji="🛡️"
            color={Colors.yellow}
          />
        </View>
      </View>

      {/* ---------------------------------------------------------- badges */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text variant="label">Rozetler</Text>
          <Text variant="micro" faint>
            {earnedCount}/{BADGES.length}
          </Text>
        </View>
        <View style={styles.badgeGrid}>
          {BADGES.map((badge) => {
            const has = earned.has(badge.key);
            return (
              <View key={badge.key} style={[styles.badge, has ? styles.badgeOn : styles.badgeOff]}>
                <Text style={[styles.badgeEmoji, !has && styles.dim]}>{badge.emoji}</Text>
                <Text
                  variant="tiny"
                  bold
                  center
                  numberOfLines={2}
                  color={has ? Colors.yellow : Colors.textFaint}>
                  {badge.nameTr}
                </Text>
                {has ? (
                  <Text variant="micro" center muted numberOfLines={3}>
                    {badge.descriptionTr}
                  </Text>
                ) : (
                  <>
                    <Text variant="micro" center faint numberOfLines={3}>
                      {ruleHint(badge)}
                    </Text>
                    <ProgressBar
                      value={ruleProgress(badge, stats)}
                      color={Colors.accentDim}
                      track={Colors.surfaceHigh}
                      height={4}
                      style={styles.badgeBar}
                    />
                  </>
                )}
              </View>
            );
          })}
        </View>
      </View>

      {/* ----------------------------------------------------- leaderboard */}
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Text variant="label">Sıralama</Text>
          <Text variant="micro" faint>
            en çok koyanlar
          </Text>
        </View>
        <Card padded={false} style={styles.boardCard}>
          <Leaderboard
            rows={leaderboard.data ?? []}
            meId={me.id}
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
  loading,
  error,
  onRetry,
}: {
  rows: LeaderboardEntry[];
  meId: string;
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

  if (error) {
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
          Henüz sıralama yok. Bir çelınc bitir, tabloya gir.
        </Text>
      </View>
    );
  }

  const top = rows.slice(0, 5);
  const mine = rows.find((row) => row.user.id === meId);
  const visible = mine && !top.some((row) => row.user.id === meId) ? [...top, mine] : top;

  return (
    <View>
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
                  koyuş
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
