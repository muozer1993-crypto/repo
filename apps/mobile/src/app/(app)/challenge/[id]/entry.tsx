import type { ChallengeType } from '@koydum/shared';
import { LIMITS, addDays, diffDayKeys, getChallengeType, t } from '@koydum/shared';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { Loading } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useAddEntry, useChallenge } from '@/hooks/queries';
import { useProofPhoto } from '@/hooks/useProofPhoto';
import { useTimezone } from '@/hooks/useTimezone';
import { ApiError } from '@/lib/api';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/theme';
import { safeDayKeysBetween, safeTodayKey } from '@/utils/datetime';
import { errorText } from '@/utils/errors';
import { formatDayKeyFriendly, formatNumber } from '@/utils/format';
import { uuidV4 } from '@/utils/ids';
import { resolveServerUrl } from '@/utils/url';

/* ------------------------------------------------------------------ utils */

/** "5,2" and "5.2" are both 5.2 — Turkish keyboards give the comma. */
function parseValue(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!cleaned) return null;
  if (!/^\d*(\.\d*)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function quickAdds(maxPerEntry: number): number[] {
  const cap = Math.max(1, Math.floor(maxPerEntry));
  const presets = cap >= 400 ? [10, 25, 50] : cap >= 100 ? [5, 10, 25] : [1, 5, 10];
  return presets.filter((value) => value <= cap);
}

/* ----------------------------------------------------------------- screen */

export default function EntryModalScreen() {
  const params = useLocalSearchParams<{ id: string; day?: string; proof?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const level = useLevel();
  const tz = useTimezone();
  const serverUrl = useAuth((s) => s.serverUrl);
  const toast = useToast();
  const photo = useProofPhoto({ keepOffline: true });

  const query = useChallenge(id);
  const detail = query.data;
  const type: ChallengeType | undefined = detail ? getChallengeType(detail.challenge.typeKey) : undefined;

  const today = safeTodayKey(tz);
  const yesterday = addDays(today, -1);
  const windowKeys = detail
    ? safeDayKeysBetween(detail.challenge.startsAt, detail.challenge.endsAt, tz)
    : [];
  // Steps go back a week like the server takes them: somebody who joined on
  // day two, or whose phone started counting mid-race, writes the days before.
  // Typed counts keep today and yesterday.
  const backfillDays =
    type?.metricType === 'auto_steps' ? LIMITS.STEPS_BACKFILL_DAYS : Math.min(1, LIMITS.MANUAL_BACKFILL_DAYS);
  const pickableDays = windowKeys
    .filter((day) => day <= today && diffDayKeys(day, today) <= backfillDays)
    .reverse();

  const requestedDay = typeof params.day === 'string' ? params.day : '';
  const initialDay = pickableDays.includes(requestedDay) ? requestedDay : today;

  const addEntry = useAddEntry(id, { append: type?.metricType === 'manual_count' });
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  // a photo picked with no connection: it goes up with the entry, now or from the queue
  const [proofLocalUri, setProofLocalUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploading = photo.uploading;

  const close = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  // a link without an id leaves the query disabled, so the spinner would never end
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <EmptyState
          emoji="🫥"
          title="Çelınc bulunamadı"
          subtitle="Bu bağlantıda çelınc numarası yok. Çelıncı açıp oradan giriş yap."
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  if (query.isPending) {
    return (
      <Screen contentStyle={styles.center}>
        <Loading label="Çelınc yükleniyor..." />
      </Screen>
    );
  }

  // Only when nothing was ever loaded, or the server says the çelınc is gone: a
  // failed background refetch (TanStack sets `isError` but keeps `data`) used to
  // swap the form for this screen and take the value being typed with it.
  const missing = query.error instanceof ApiError && query.error.status === 404;
  if (!detail || !type || missing) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <EmptyState
          emoji="🫥"
          title="Giriş yapılamıyor"
          subtitle={
            !detail || missing ? errorText(query.error, 'Çelınc bilgisi gelmedi.') : 'Bu çelıncın tipi tanınmadı.'
          }
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  const { challenge } = detail;
  const selectedDay = dayKey ?? initialDay;
  // the creator's switch is the rule (the server enforces exactly this); the
  // catalog flag only seeded that switch in the wizard
  const proofRequired = challenge.proofRequired;
  const emphasiseProof = proofRequired || params.proof === '1' || type.metricType === 'manual_lower_is_better';
  const value = parseValue(raw);
  const chips = quickAdds(type.maxPerEntry);
  const notActive = challenge.status !== 'active';
  const notPlaying = detail.me?.status !== 'accepted';
  const dayEntry = detail.myEntries.find((entry) => entry.dayKey === selectedDay);
  // the phone already reported this day: the server will answer 409 device_locked
  const deviceLocked = dayEntry?.source === 'usage_stats';
  // friends threw this step day out: only the phone writes it now (409 day_rejected)
  const stepsRejected =
    type.metricType === 'auto_steps' &&
    !!dayEntry &&
    detail.disputes.some((row) => row.entryId === dayEntry.id && row.status === 'upheld');
  const dayLocked = deviceLocked || stepsRejected;
  const dayLabel = formatDayKeyFriendly(selectedDay, today, yesterday);
  // "8 Ekim" keeps its capital in a sentence, "Bugün" does not
  const dayWord = selectedDay === today ? 'bugün' : selectedDay === yesterday ? 'dün' : dayLabel;

  /**
   * `manual_count` appends, so the server rejects anything that pushes the day's
   * SUM past `maxPerDay` (400 `daily_cap`). The quick-add chips on the detail
   * screen already know this; without the same check here a legal single value
   * round-trips to a server error.
   */
  const appends = type.metricType === 'manual_count';
  const dayTotal = appends
    ? detail.myEntries
        .filter((entry) => entry.dayKey === selectedDay && entry.status !== 'rejected')
        .reduce((sum, entry) => sum + entry.value, 0)
    : 0;
  const remaining = appends ? Math.max(0, type.maxPerDay - dayTotal) : type.maxPerEntry;
  const ceiling = Math.min(type.maxPerEntry, remaining);

  const bump = (delta: number) => {
    const next = Math.min(ceiling, (value ?? 0) + delta);
    setRaw(String(next).replace('.', ','));
    setError(null);
  };

  const pick = async (from: 'camera' | 'library') => {
    setError(null);
    const picked = await photo.pick(from);
    if (picked?.url) {
      setProofUrl(picked.url);
      setProofLocalUri(null);
      toast({ title: 'Kanıt yüklendi', body: 'Fotoğraf girişe eklendi.', kind: 'success' });
    } else if (picked?.localUri) {
      setProofLocalUri(picked.localUri);
      setProofUrl(null);
      toast({ title: 'Fotoğraf telefonda', body: 'Bağlantı gelince girişle birlikte gider.', kind: 'info' });
    }
  };

  const removeProof = () => {
    setProofUrl(null);
    setProofLocalUri(null);
  };

  const submit = async () => {
    if (value === null) {
      setError('Bir sayı yaz kanka.');
      return;
    }
    if (value > type.maxPerEntry) {
      setError(
        `Tek girişte en fazla ${formatNumber(type.maxPerEntry)} ${type.unitTr} yazabilirsin. Fazlasını ayrı giriş yap.`
      );
      return;
    }
    if (value <= 0 && type.direction === 'higher') {
      setError('Sıfırdan büyük bir sayı yaz.');
      return;
    }
    if (appends && value > remaining) {
      setError(
        remaining <= 0
          ? `${dayLabel} için günlük tavan doldu (${formatNumber(type.maxPerDay)} ${type.unitTr}).`
          : `${dayLabel} için ${formatNumber(remaining)} ${type.unitTr} kaldı. Günlük tavan ${formatNumber(type.maxPerDay)} ${type.unitTr}.`
      );
      return;
    }
    if (proofRequired && !proofUrl && !proofLocalUri) {
      setError(t('proof_needed', level));
      return;
    }
    try {
      const response = await addEntry.mutateAsync({
        dayKey: selectedDay,
        value,
        source: 'manual',
        note: note.trim() ? note.trim() : undefined,
        proofUrl: proofUrl ?? undefined,
        proofLocalUri: proofUrl ? undefined : (proofLocalUri ?? undefined),
        clientTime: new Date().toISOString(),
        // append metrics get an idempotency key: a request that timed out on the
        // way back and is replayed from the queue must not count twice
        sessionId: appends ? uuidV4() : undefined,
      });
      toast(
        response.queued
          ? {
              // parked in the offline queue: the standings do not move yet
              title: 'Sıraya alındı',
              body: `${formatNumber(value)} ${type.unitTr} · bağlantı gelince gönderilecek.`,
              kind: 'info',
            }
          : {
              title: 'Yazıldı',
              body: `${formatNumber(value)} ${type.unitTr} · ${dayWord}`,
              kind: 'success',
            }
      );
      close();
    } catch (err) {
      setError(errorText(err, 'Giriş kaydedilemedi.'));
    }
  };

  return (
    <Screen scroll keyboard contentStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.headerBody}>
          <Text variant="title" numberOfLines={1}>
            {type.emoji} {challenge.title || type.nameTr}
          </Text>
          <Text variant="tiny" muted numberOfLines={1}>
            {type.metricType === 'manual_lower_is_better' ? 'Günlük değerini gir' : 'Yeni giriş'} ·{' '}
            {type.unitTr}
          </Text>
        </View>
        <Button title="Kapat" variant="ghost" size="sm" onPress={close} />
      </View>
      {query.isRefetchError ? (
        <Text variant="tiny" faint style={styles.stale}>
          Sunucuya ulaşamıyorum, bilgiler son bilinen hali. Kaydedersen giriş sıraya alınır, bağlantı gelince gider.
        </Text>
      ) : null}

      {notActive || notPlaying || dayLocked ? (
        <Card edgeColor={Colors.danger}>
          <Text variant="small">
            {notActive
              ? 'Bu çelınc şu an aktif değil, giriş kabul edilmiyor.'
              : notPlaying
                ? 'Bu çelıncta oyuncu değilsin, giriş yapamazsın.'
                : deviceLocked
                  ? `${dayLabel} için değeri telefon kendisi okudu, elle değiştirilemez.`
                  : `${dayLabel} için yazdığını kankalar itirazla yaktı. O güne artık sadece telefonun saydığı adım yazılır.`}
          </Text>
        </Card>
      ) : null}

      {/* ------------------------------------------------------- value */}
      <Card>
        <Text variant="label" style={styles.label}>
          Değer
        </Text>
        <View style={styles.valueRow}>
          <Input
            value={raw}
            onChangeText={(text) => {
              setRaw(text);
              setError(null);
            }}
            placeholder="0"
            keyboardType={Platform.OS === 'web' ? 'default' : 'decimal-pad'}
            inputMode="decimal"
            style={styles.valueInput}
            suffix={type.unitTr}
            containerStyle={styles.valueField}
            maxLength={9}
          />
        </View>
        <View style={styles.chipRow}>
          {chips.map((amount) => (
            <Chip
              key={amount}
              label={`+${formatNumber(amount)}`}
              color={Colors.yellow}
              onPress={() => bump(amount)}
            />
          ))}
          {raw ? <Chip label="Temizle" color={Colors.textMuted} onPress={() => setRaw('')} /> : null}
        </View>
        <Text variant="tiny" faint style={styles.hint}>
          Tek girişte en fazla {formatNumber(type.maxPerEntry)} {type.unitTr} · günlük tavan{' '}
          {formatNumber(type.maxPerDay)} {type.unitTr}
        </Text>
        {appends ? (
          <Text
            variant="tiny"
            color={remaining <= 0 ? Colors.danger : Colors.textFaint}
            style={styles.hint}>
            {remaining <= 0
              ? `${dayLabel} için tavan doldu (${formatNumber(dayTotal)} ${type.unitTr} girdin).`
              : `${dayLabel} için kalan: ${formatNumber(remaining)} ${type.unitTr}.`}
          </Text>
        ) : null}
      </Card>

      {/* --------------------------------------------------------- day */}
      <Card>
        <Text variant="label" style={styles.label}>
          Hangi gün
        </Text>
        {pickableDays.length > 2 ? (
          <View style={styles.dayChips}>
            {pickableDays.map((day) => (
              <Chip
                key={day}
                label={formatDayKeyFriendly(day, today, yesterday)}
                selected={day === selectedDay}
                color={day === selectedDay ? Colors.accent : Colors.textMuted}
                onPress={() => {
                  setDayKey(day);
                  setError(null);
                }}
              />
            ))}
          </View>
        ) : pickableDays.length === 2 ? (
          <SegmentedControl
            options={pickableDays.map((day) => ({ value: day, label: formatDayKeyFriendly(day, today, yesterday) }))}
            value={selectedDay}
            onChange={(next) => {
              setDayKey(next);
              setError(null);
            }}
          />
        ) : (
          <Text variant="small" muted>
            Sadece bugüne giriş yapabilirsin.
          </Text>
        )}
      </Card>

      {/* -------------------------------------------------------- proof */}
      <Card edgeColor={emphasiseProof ? Colors.yellow : undefined}>
        <Text variant="label" style={styles.label}>
          Kanıt {proofRequired ? '(zorunlu)' : '(isteğe bağlı)'}
        </Text>
        {emphasiseProof ? (
          <Text variant="small" muted style={styles.hint}>
            {t('proof_needed', level)}
          </Text>
        ) : null}

        {proofUrl || proofLocalUri ? (
          <View style={styles.proofWrap}>
            <Image
              source={{ uri: proofUrl ? resolveServerUrl(proofUrl, serverUrl) : (proofLocalUri as string) }}
              style={styles.proofPreview}
              contentFit="cover"
              transition={120}
            />
            {!proofUrl ? (
              <Text variant="tiny" faint>
                Fotoğraf henüz gitmedi, telefonda bekliyor. Kaydedince girişle birlikte gider.
              </Text>
            ) : null}
            <Button title="Fotoğrafı kaldır" variant="ghost" size="sm" onPress={removeProof} />
          </View>
        ) : (
          <View style={styles.row}>
            {Platform.OS !== 'web' ? (
              <Button
                title="Kamera"
                icon="📷"
                variant="secondary"
                size="md"
                style={styles.grow}
                loading={uploading}
                onPress={() => void pick('camera')}
              />
            ) : null}
            <Button
              title="Galeri"
              icon="🖼️"
              variant="secondary"
              size="md"
              style={styles.grow}
              loading={uploading}
              onPress={() => void pick('library')}
            />
          </View>
        )}
      </Card>

      {/* --------------------------------------------------------- note */}
      <Card>
        <Text variant="label" style={styles.label}>
          Not (isteğe bağlı)
        </Text>
        <Input
          value={note}
          onChangeText={setNote}
          placeholder="Akşam koşusu, park turu..."
          maxLength={LIMITS.NOTE_MAX}
          multiline
          hint={`${note.length}/${LIMITS.NOTE_MAX}`}
        />
      </Card>

      {error ? (
        <Text variant="small" color={Colors.danger} style={styles.error}>
          {error}
        </Text>
      ) : null}

      <Button
        title="Kaydet"
        size="xl"
        fullWidth
        loading={addEntry.isPending}
        disabled={uploading || notActive || notPlaying || dayLocked}
        onPress={() => void submit()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.lg },
  center: { justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  headerBody: { flex: 1, gap: 2 },
  label: { marginBottom: Spacing.sm },
  valueRow: { flexDirection: 'row', alignItems: 'center' },
  valueField: { flex: 1 },
  valueInput: {
    fontSize: FontSize.huge,
    fontWeight: FontWeight.black,
    color: Colors.text,
    paddingVertical: Spacing.sm,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.md },
  dayChips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  hint: { marginTop: Spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  grow: { flex: 1 },
  proofWrap: { gap: Spacing.sm },
  proofPreview: {
    width: '100%',
    height: 200,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceHigh,
  },
  error: { marginTop: -Spacing.sm },
  stale: { marginTop: -Spacing.sm },
});
