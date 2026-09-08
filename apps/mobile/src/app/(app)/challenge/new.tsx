import {
  CATEGORY_LABELS_TR,
  CATEGORY_ORDER,
  CHALLENGE_TYPES,
  LIMITS,
  getChallengeType,
  isValidHHmm,
  t,
  type ChallengeType,
  type PublicUser,
  type VulgarityLevel,
} from '@koydum/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { Loading } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Text } from '@/components/Text';
import { useCreateChallenge, useFriends } from '@/hooks/queries';
import { ApiError } from '@/lib/api';
import { useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { formatDayKey, formatTime } from '@/utils/format';

/* ------------------------------------------------------------------ copy */

/** Inline copy that has no MICROCOPY key yet, written for all three levels. */
function byLevel(level: VulgarityLevel, l1: string, l2: string, l3: string): string {
  if (level === 1) return l1;
  if (level === 3) return l3;
  return l2;
}

const STEP_LABELS = ['TÜR', 'AYARLAR', 'KANKALAR', 'ÖZET'] as const;
const DURATION_CHOICES = [1, 3, 7, 14, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type StartMode = 'now' | 'tomorrow';
type DurationChoice = number | 'custom';
type InfoTab = 'measure' | 'cheat' | null;

/* ------------------------------------------------------------- utilities */

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Çelinç açılamadı. Biraz sonra tekrar dene.';
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** "8 Eylül Salı · 09:00" */
function formatMoment(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return `${formatDayKey(localDayKey(date), { withWeekday: true })} · ${formatTime(iso)}`;
}

/** Start/end as ISO strings; "Hemen" means now (the server allows a 5 dk grace). */
function computeWindow(startMode: StartMode, days: number): { startsAt: string; endsAt: string } {
  const start = new Date();
  if (startMode === 'tomorrow') {
    start.setDate(start.getDate() + 1);
    start.setHours(9, 0, 0, 0);
  }
  const end = new Date(start.getTime() + days * DAY_MS);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

function describeType(type: ChallengeType, level: VulgarityLevel): string {
  return level === 1 ? type.descriptionPoliteTr : type.descriptionTr;
}

/** The catalog's suggested reward can be longer than the field allows. */
function clip(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('tr-TR');
}

/* ------------------------------------------------------------ subviews */

function StepBar({ step }: { step: number }) {
  return (
    <View style={styles.stepBar}>
      {STEP_LABELS.map((label, index) => {
        const done = index <= step;
        return (
          <View key={label} style={styles.stepCol}>
            <View style={[styles.stepTrack, done && styles.stepTrackOn]} />
            <Text
              variant="micro"
              numberOfLines={1}
              color={index === step ? Colors.accent : done ? Colors.textMuted : Colors.textFaint}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function InfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.infoBlock}>
      <Text variant="label" color={Colors.yellow}>
        {title}
      </Text>
      <Text variant="tiny" muted>
        {body}
      </Text>
    </View>
  );
}

interface TypeRowProps {
  type: ChallengeType;
  level: VulgarityLevel;
  selected: boolean;
  infoTab: InfoTab;
  onSelect: (type: ChallengeType) => void;
  onInfo: (tab: Exclude<InfoTab, null>) => void;
}

function TypeRow({ type, level, selected, infoTab, onSelect, onInfo }: TypeRowProps) {
  return (
    <Card
      padded={false}
      style={selected ? styles.typeCardOn : styles.typeCard}
      edgeColor={selected ? Colors.accent : undefined}>
      {/* the head is the only pressable part: nesting it inside a pressable Card
          would fire both handlers on web */}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => onSelect(type)}
        style={({ pressed }) => [styles.typeHead, pressed && styles.pressed]}>
        <Text style={styles.typeEmoji}>{type.emoji}</Text>
        <View style={styles.grow}>
          <View style={styles.typeTitleRow}>
            <Text variant="lead" numberOfLines={1} style={styles.grow}>
              {type.nameTr}
            </Text>
            <Chip label={type.unitTr} size="sm" color={selected ? Colors.accent : Colors.textFaint} />
          </View>
          <Text variant="tiny" muted style={styles.typeDesc}>
            {describeType(type, level)}
          </Text>
        </View>
      </Pressable>

      {selected ? (
        <View style={styles.typeInfo}>
          <View style={styles.infoTabs}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: infoTab === 'measure' }}
              onPress={() => onInfo('measure')}
              style={[styles.infoTab, infoTab === 'measure' && styles.infoTabOn]}>
              <Text variant="micro" color={infoTab === 'measure' ? Colors.accent : Colors.textMuted}>
                {infoTab === 'measure' ? '▾' : '▸'} Nasıl ölçülür?
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: infoTab === 'cheat' }}
              onPress={() => onInfo('cheat')}
              style={[styles.infoTab, infoTab === 'cheat' && styles.infoTabOn]}>
              <Text variant="micro" color={infoTab === 'cheat' ? Colors.accent : Colors.textMuted}>
                {infoTab === 'cheat' ? '▾' : '▸'} Hile olur mu?
              </Text>
            </Pressable>
          </View>
          {infoTab === 'measure' ? (
            <InfoBlock title="Nasıl ölçülür?" body={type.howMeasuredTr} />
          ) : null}
          {infoTab === 'cheat' ? <InfoBlock title="Hile olur mu?" body={type.antiCheatTr} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function FriendRow({
  user,
  selected,
  onToggle,
}: {
  user: PublicUser;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={() => onToggle(user.id)}
      style={({ pressed }) => [
        styles.friendRow,
        selected && styles.friendRowOn,
        pressed && styles.pressed,
      ]}>
      <Avatar emoji={user.avatarEmoji} name={user.displayName} size={40} ring={selected ? Colors.accent : null} />
      <View style={styles.grow}>
        <Text variant="body" bold numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text variant="tiny" faint numberOfLines={1}>
          @{user.username}
        </Text>
      </View>
      <View style={[styles.check, selected && styles.checkOn]}>
        <Text variant="tiny" bold color={selected ? Colors.white : Colors.textFaint}>
          {selected ? '✓' : ''}
        </Text>
      </View>
    </Pressable>
  );
}

function SummaryRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text variant="label" style={styles.summaryLabel}>
        {label}
      </Text>
      <Text variant="small" color={color} style={styles.grow}>
        {value}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------- screen */

export default function NewChallengeScreen() {
  const level = useLevel();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const preselected =
    typeof params.friend === 'string'
      ? params.friend
      : Array.isArray(params.friend)
        ? params.friend[0]
        : undefined;

  const friendsQuery = useFriends();
  const create = useCreateChallenge();

  const [step, setStep] = useState(0);
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [infoTab, setInfoTab] = useState<InfoTab>(null);

  const [title, setTitle] = useState('');
  const [startMode, setStartMode] = useState<StartMode>('now');
  const [durationChoice, setDurationChoice] = useState<DurationChoice>(3);
  const [customDays, setCustomDays] = useState('');
  const [deadlineTime, setDeadlineTime] = useState('');
  const [proofRequired, setProofRequired] = useState(false);
  const [rewardText, setRewardText] = useState('');
  const [penaltyText, setPenaltyText] = useState('');

  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>(preselected ? [preselected] : []);

  const type = typeKey ? getChallengeType(typeKey) : undefined;
  const needsDeadline = type?.metricType === 'checkin_deadline';

  const rawDays = durationChoice === 'custom' ? Number(customDays.replace(',', '.')) : durationChoice;
  const days = Number.isFinite(rawDays) ? rawDays : 0;
  const durationMs = days * DAY_MS;
  const daysValid =
    Number.isInteger(days) &&
    durationMs > LIMITS.MIN_DURATION_MS &&
    durationMs <= LIMITS.MAX_DURATION_MS;
  const deadlineValid = !needsDeadline || isValidHHmm(deadlineTime.trim());
  const settingsValid = !!type && daysValid && deadlineValid;
  const friendsValid =
    selectedIds.length >= LIMITS.PARTICIPANTS_MIN && selectedIds.length <= LIMITS.PARTICIPANTS_MAX;

  const friends = friendsQuery.data?.friends ?? [];
  const query = normalize(search);
  const visibleFriends = query
    ? friends.filter(
        (friend) =>
          normalize(friend.displayName).includes(query) || normalize(friend.username).includes(query)
      )
    : friends;
  const chosen = friends.filter((friend) => selectedIds.includes(friend.id));

  const preview = computeWindow(startMode, daysValid ? days : (type?.defaultDurationDays ?? 1));
  const finalTitle = (title.trim() || type?.nameTr || '').slice(0, LIMITS.CHALLENGE_TITLE_MAX);

  const stepValid = step === 0 ? !!type : step === 1 ? settingsValid : step === 2 ? friendsValid : true;

  const hint = (() => {
    if (step === 0 && !type) {
      return byLevel(
        level,
        'Devam etmek için bir çelinç türü seç.',
        'Önce bir tür seç lan, boşluğa koyamayız.',
        'Tür seçmeden koyamazsın. Birini seç 🍆'
      );
    }
    if (step === 1 && !daysValid) {
      return `Gün sayısı 1 ile ${LIMITS.MAX_DURATION_DAYS} arasında olmalı.`;
    }
    if (step === 1 && !deadlineValid) {
      return 'Check-in saatini SS:dd yaz (ör. 07:30).';
    }
    if (step === 2 && selectedIds.length === 0) {
      return byLevel(
        level,
        'En az bir kanka seçmelisin.',
        'Kime koyacaksın lan? En az bir kanka seç.',
        'Kurban seçmeden olmaz. En az bir kanka işaretle 🍆'
      );
    }
    if (step === 2 && selectedIds.length > LIMITS.PARTICIPANTS_MAX) {
      return `En fazla ${LIMITS.PARTICIPANTS_MAX} kişi seçebilirsin.`;
    }
    return null;
  })();

  const chooseType = (next: ChallengeType) => {
    setInfoTab(null);
    if (next.key === typeKey) return;
    setTypeKey(next.key);
    setDurationChoice(
      (DURATION_CHOICES as readonly number[]).includes(next.defaultDurationDays)
        ? next.defaultDurationDays
        : 'custom'
    );
    setCustomDays(String(next.defaultDurationDays));
    setDeadlineTime(next.defaultDeadlineTime ?? '');
    setProofRequired(next.proofRequired);
    setRewardText(clip(next.suggestedRewardTr, LIMITS.REWARD_TEXT_MAX));
  };

  const toggleFriend = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= LIMITS.PARTICIPANTS_MAX) return current;
      return [...current, id];
    });
  };

  const goNext = () => {
    if (!stepValid) return;
    if (step < 3) setStep(step + 1);
  };

  const goBack = () => {
    if (step === 0) {
      router.back();
      return;
    }
    setStep(step - 1);
  };

  const submit = async () => {
    if (!type || !settingsValid || !friendsValid) return;
    const { startsAt, endsAt } = computeWindow(startMode, days);
    try {
      const challenge = await create.mutateAsync({
        typeKey: type.key,
        title: finalTitle || undefined,
        startsAt,
        endsAt,
        participantIds: selectedIds,
        rewardText: rewardText.trim() || undefined,
        penaltyText: penaltyText.trim() || undefined,
        deadlineTime: needsDeadline ? deadlineTime.trim() : undefined,
        proofRequired,
      });
      router.replace(`/challenge/${challenge.id}`);
    } catch {
      // surfaced from create.error below
    }
  };

  return (
    <Screen padded={false} keyboard glow>
      <View style={styles.header}>
        <View style={styles.grow}>
          <Text variant="title" numberOfLines={1}>
            {t('create_challenge_cta', level)}
          </Text>
          <Text variant="tiny" faint>
            {step + 1}/4 · {STEP_LABELS[step]}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Kapat"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Text variant="lead" muted>
            ✕
          </Text>
        </Pressable>
      </View>

      <StepBar step={step} />

      <ScrollView
        style={styles.grow}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {/* ---------------------------------------------------- 1. TÜR */}
        {step === 0 ? (
          <View style={styles.section}>
            <Text variant="big">
              {byLevel(
                level,
                'Hangi konuda yarışalım?',
                'Ne üzerine koyuyoruz?',
                'Ne üzerine saplayacağız? 🍆'
              )}
            </Text>
            {CATEGORY_ORDER.map((category) => {
              const list = CHALLENGE_TYPES.filter((item) => item.category === category);
              if (list.length === 0) return null;
              return (
                <View key={category} style={styles.group}>
                  <Text variant="label">{CATEGORY_LABELS_TR[category] ?? category}</Text>
                  {list.map((item) => (
                    <TypeRow
                      key={item.key}
                      type={item}
                      level={level}
                      selected={item.key === typeKey}
                      infoTab={item.key === typeKey ? infoTab : null}
                      onSelect={chooseType}
                      onInfo={(tab) => setInfoTab(infoTab === tab ? null : tab)}
                    />
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}

        {/* ----------------------------------------------- 2. AYARLAR */}
        {step === 1 && type ? (
          <View style={styles.section}>
            <Text variant="big">
              {byLevel(level, 'Kuralları belirle', 'Kuralları koy', 'Kuralları koy, kaçış olmasın')}
            </Text>

            <Card>
              <Text variant="lead">
                {type.emoji} {type.nameTr}
              </Text>
              <Text variant="tiny" muted style={styles.typeDesc}>
                {describeType(type, level)}
              </Text>
            </Card>

            <Input
              label="Başlık (isteğe bağlı)"
              placeholder={type.nameTr}
              value={title}
              onChangeText={setTitle}
              maxLength={LIMITS.CHALLENGE_TITLE_MAX}
              hint={`Boş bırakırsan "${type.nameTr}" yazar. ${title.length}/${LIMITS.CHALLENGE_TITLE_MAX}`}
            />

            <View style={styles.field}>
              <Text variant="label">Ne zaman başlasın?</Text>
              <SegmentedControl<StartMode>
                options={[
                  { value: 'now', label: 'Hemen', emoji: '⚡' },
                  { value: 'tomorrow', label: 'Yarın 09:00', emoji: '🌅' },
                ]}
                value={startMode}
                onChange={setStartMode}
              />
            </View>

            <View style={styles.field}>
              <Text variant="label">Kaç gün sürsün?</Text>
              <View style={styles.chipRow}>
                {DURATION_CHOICES.map((option) => (
                  <Chip
                    key={option}
                    label={`${option} gün`}
                    selected={durationChoice === option}
                    color={durationChoice === option ? Colors.accent : Colors.textMuted}
                    onPress={() => setDurationChoice(option)}
                  />
                ))}
                <Chip
                  label="Özel"
                  selected={durationChoice === 'custom'}
                  color={durationChoice === 'custom' ? Colors.accent : Colors.textMuted}
                  onPress={() => setDurationChoice('custom')}
                />
              </View>
              {durationChoice === 'custom' ? (
                <Input
                  placeholder="Örn. 21"
                  value={customDays}
                  onChangeText={(value) => setCustomDays(value.replace(/[^0-9]/g, '').slice(0, 2))}
                  keyboardType="number-pad"
                  suffix="gün"
                  error={
                    customDays && !daysValid
                      ? `1 ile ${LIMITS.MAX_DURATION_DAYS} gün arası yazmalısın.`
                      : null
                  }
                  hint={`En az 1, en fazla ${LIMITS.MAX_DURATION_DAYS} gün.`}
                />
              ) : null}
            </View>

            {needsDeadline ? (
              <Input
                label="Check-in saati"
                placeholder={type.defaultDeadlineTime ?? '07:30'}
                value={deadlineTime}
                onChangeText={(value) => setDeadlineTime(value.replace(/[^0-9:]/g, '').slice(0, 5))}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                error={deadlineTime && !deadlineValid ? 'Saat SS:dd olmalı (ör. 07:30).' : null}
                hint="Bu saate kadar 'GELDİM' diyen o günü kazanır."
              />
            ) : null}

            <View style={styles.switchRow}>
              <View style={styles.grow}>
                <Text variant="body" bold>
                  Fotoğraf kanıtı zorunlu
                </Text>
                <Text variant="tiny" muted>
                  {t('proof_needed', level)}
                </Text>
              </View>
              <Switch
                value={proofRequired}
                onValueChange={setProofRequired}
                trackColor={{ false: Colors.surfaceHigh, true: Colors.accentDim }}
                thumbColor={proofRequired ? Colors.accent : Colors.textFaint}
                ios_backgroundColor={Colors.surfaceHigh}
              />
            </View>

            <Input
              label="Ödül (kazanan ne alacak?)"
              placeholder={clip(type.suggestedRewardTr, LIMITS.REWARD_TEXT_MAX)}
              value={rewardText}
              onChangeText={setRewardText}
              maxLength={LIMITS.REWARD_TEXT_MAX}
              multiline
              hint={`${rewardText.length}/${LIMITS.REWARD_TEXT_MAX}`}
            />
            <Input
              label="Ceza (kaybeden ne yapacak?)"
              placeholder={byLevel(
                level,
                'Örn. kaybeden herkese kahve ısmarlar.',
                'Örn. kaybeden bir hafta profil fotoğrafını değiştirir.',
                'Örn. kaybeden gruba rezil bir fotoğrafını atar.'
              )}
              value={penaltyText}
              onChangeText={setPenaltyText}
              maxLength={LIMITS.PENALTY_TEXT_MAX}
              multiline
              hint={`${penaltyText.length}/${LIMITS.PENALTY_TEXT_MAX}`}
            />

            <Card style={styles.windowCard}>
              <SummaryRow label="Başlangıç" value={formatMoment(preview.startsAt)} />
              <SummaryRow label="Bitiş" value={formatMoment(preview.endsAt)} />
            </Card>
          </View>
        ) : null}

        {/* ---------------------------------------------- 3. KANKALAR */}
        {step === 2 ? (
          <View style={styles.section}>
            <Text variant="big">
              {byLevel(level, 'Kimlerle yarışacaksın?', 'Kime koyacaksın?', 'Kim yiyecek bakalım? 🍆')}
            </Text>

            {friendsQuery.isLoading ? (
              <Loading label="Kankalar geliyor..." />
            ) : friendsQuery.isError ? (
              <Card edgeColor={Colors.danger}>
                <Text variant="small" color={Colors.danger}>
                  {errorText(friendsQuery.error)}
                </Text>
                <Button
                  title="Tekrar dene"
                  variant="secondary"
                  size="sm"
                  style={styles.retry}
                  onPress={() => void friendsQuery.refetch()}
                />
              </Card>
            ) : friends.length === 0 ? (
              <EmptyState
                emoji="👻"
                title="Kanka yok"
                subtitle={t('add_friend_empty', level)}
                actionLabel="Kanka ekle"
                onAction={() => router.replace('/(app)/(tabs)/friends')}
              />
            ) : (
              <>
                <Input
                  placeholder="Kanka ara..."
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text variant="tiny" faint>
                  {selectedIds.length}/{LIMITS.PARTICIPANTS_MAX} seçildi
                </Text>
                {visibleFriends.length === 0 ? (
                  <Text variant="small" muted center style={styles.noMatch}>
                    "{search.trim()}" diye biri yok.
                  </Text>
                ) : (
                  visibleFriends.map((friend) => (
                    <FriendRow
                      key={friend.id}
                      user={friend}
                      selected={selectedIds.includes(friend.id)}
                      onToggle={toggleFriend}
                    />
                  ))
                )}
              </>
            )}
          </View>
        ) : null}

        {/* -------------------------------------------------- 4. ÖZET */}
        {step === 3 && type ? (
          <View style={styles.section}>
            <Text variant="big">
              {byLevel(level, 'Son bir kontrol', 'Son bir bak lan', 'Son bir bak, sonra sapla 🍆')}
            </Text>

            <Card glow edgeColor={Colors.accent}>
              <View style={styles.summaryHead}>
                <Text style={styles.typeEmoji}>{type.emoji}</Text>
                <View style={styles.grow}>
                  <Text variant="title" numberOfLines={2}>
                    {finalTitle}
                  </Text>
                  <Text variant="tiny" muted>
                    {type.nameTr} · {type.unitTr} · {type.direction === 'higher' ? 'çok olan kazanır' : 'az olan kazanır'}
                  </Text>
                </View>
              </View>

              <View style={styles.summaryBody}>
                <SummaryRow label="Başlangıç" value={formatMoment(preview.startsAt)} />
                <SummaryRow label="Bitiş" value={formatMoment(preview.endsAt)} />
                <SummaryRow label="Süre" value={`${days} gün`} />
                {needsDeadline ? (
                  <SummaryRow label="Check-in" value={`${deadlineTime.trim()}'e kadar`} />
                ) : null}
                <SummaryRow
                  label="Kanıt"
                  value={proofRequired ? 'Fotoğraf zorunlu 📸' : 'Fotoğraf istemiyoruz'}
                  color={proofRequired ? Colors.yellow : undefined}
                />
                <SummaryRow
                  label="Ödül"
                  value={rewardText.trim() || 'Ödül yazılmadı'}
                  color={rewardText.trim() ? Colors.success : Colors.textFaint}
                />
                <SummaryRow
                  label="Ceza"
                  value={penaltyText.trim() || 'Ceza yazılmadı'}
                  color={penaltyText.trim() ? Colors.danger : Colors.textFaint}
                />
              </View>

              <View style={styles.summaryPeople}>
                <Text variant="label">Kankalar ({chosen.length})</Text>
                <View style={styles.avatarRow}>
                  {chosen.map((friend) => (
                    <View key={friend.id} style={styles.avatarItem}>
                      <Avatar emoji={friend.avatarEmoji} name={friend.displayName} size={36} />
                      <Text variant="micro" muted numberOfLines={1} style={styles.avatarName}>
                        {friend.displayName}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </Card>

            <Text variant="small" muted center>
              {byLevel(
                level,
                'Onaylarsan davet gider, kabul edenler yarışa girer.',
                'Bas şuna, kankalara davet gitsin. Kabul etmeyen korkak yazılır.',
                'Bas şuna. Davet gitsin, kim kime koyacak görelim 🍆'
              )}
            </Text>

            {create.isError ? (
              <Card edgeColor={Colors.danger}>
                <Text variant="small" color={Colors.danger}>
                  {errorText(create.error)}
                </Text>
              </Card>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
        {hint ? (
          <Text variant="tiny" color={Colors.yellow} center>
            {hint}
          </Text>
        ) : null}
        <View style={styles.footerRow}>
          <Button
            title={step === 0 ? 'Vazgeç' : 'Geri'}
            variant="ghost"
            size="lg"
            style={styles.backButton}
            onPress={goBack}
          />
          {step < 3 ? (
            <Button
              title="İleri"
              size="lg"
              style={styles.nextButton}
              disabled={!stepValid}
              onPress={goNext}
            />
          ) : (
            <Button
              title="KOY BAKALIM"
              size="lg"
              style={styles.nextButton}
              loading={create.isPending}
              disabled={!stepValid || !settingsValid || !friendsValid}
              onPress={() => void submit()}
            />
          )}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  pressed: { opacity: 0.75 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },

  stepBar: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  stepCol: { flex: 1, gap: Spacing.xs },
  stepTrack: { height: 4, borderRadius: 2, backgroundColor: Colors.surfaceHigh },
  stepTrackOn: { backgroundColor: Colors.accent },

  scroll: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl },
  section: { gap: Spacing.lg, paddingTop: Spacing.sm },
  group: { gap: Spacing.sm },

  typeCard: {},
  typeCardOn: { borderColor: Colors.accent },
  typeHead: {
    flexDirection: 'row',
    gap: Spacing.md,
    alignItems: 'flex-start',
    padding: Spacing.lg,
  },
  typeEmoji: { fontSize: 30, lineHeight: 38 },
  typeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  typeDesc: { marginTop: Spacing.xs },
  typeInfo: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
  },
  infoTabs: { flexDirection: 'row', gap: Spacing.sm, flexWrap: 'wrap' },
  infoTab: {
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  infoTabOn: { borderColor: Colors.accent, backgroundColor: Colors.surfaceHigh },
  infoBlock: {
    gap: Spacing.xs,
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceHigh,
  },

  field: { gap: Spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  windowCard: { gap: Spacing.sm },

  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  friendRowOn: { borderColor: Colors.accent, backgroundColor: Colors.surfaceHigh },
  check: {
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  noMatch: { paddingVertical: Spacing.xl },
  retry: { marginTop: Spacing.md, alignSelf: 'flex-start' },

  summaryHead: { flexDirection: 'row', gap: Spacing.md, alignItems: 'flex-start' },
  summaryBody: { marginTop: Spacing.lg, gap: Spacing.sm },
  summaryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  summaryLabel: { width: 96, paddingTop: 2 },
  summaryPeople: { marginTop: Spacing.lg, gap: Spacing.sm },
  avatarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  avatarItem: { alignItems: 'center', width: 56, gap: 2 },
  avatarName: { textAlign: 'center' },

  footer: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    gap: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  footerRow: { flexDirection: 'row', gap: Spacing.md, alignItems: 'center' },
  backButton: { flex: 1 },
  nextButton: { flex: 2 },
});
