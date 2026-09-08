import type { ChallengeType } from '@koydum/shared';
import { LIMITS, addDays, getChallengeType, t } from '@koydum/shared';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
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
import { useApi } from '@/hooks/useApi';
import { ApiError, type ApiClient } from '@/lib/api';
import { useTimezone } from '@/hooks/useTimezone';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, FontSize, FontWeight, Radius, Spacing } from '@/theme';
import { safeDayKeysBetween, safeTodayKey } from '@/utils/datetime';
import { formatNumber } from '@/utils/format';

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

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function absoluteUrl(url: string, baseUrl: string): string {
  if (/^(https?:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('file:')) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Native FormData takes the `{ uri, name, type }` shape `api.uploadPhoto` builds;
 * a browser needs a real Blob, so the web path fetches the picked object URL first.
 */
async function uploadProof(api: ApiClient, asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const guessed = asset.fileName?.trim();
  const name = guessed && /\.[a-z0-9]{3,4}$/i.test(guessed) ? guessed : 'kanit.jpg';
  if (Platform.OS === 'web') {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    const form = new FormData();
    form.append('file', blob, name);
    const result = await api.request<{ url: string }>('POST', '/uploads', { formData: form });
    return result.url;
  }
  const result = await api.uploadPhoto(asset.uri, name);
  return result.url;
}

/* ----------------------------------------------------------------- screen */

export default function EntryModalScreen() {
  const params = useLocalSearchParams<{ id: string; day?: string; proof?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const level = useLevel();
  const me = useAuth((s) => s.me);
  const tz = useTimezone();
  const serverUrl = useAuth((s) => s.serverUrl);
  const api = useApi();
  const toast = useToast();

  const query = useChallenge(id);
  const detail = query.data;
  const type: ChallengeType | undefined = detail ? getChallengeType(detail.challenge.typeKey) : undefined;

  const today = safeTodayKey(tz);
  const yesterday = addDays(today, -1);
  const windowKeys = detail
    ? safeDayKeysBetween(detail.challenge.startsAt, detail.challenge.endsAt, tz)
    : [];
  const yesterdayAllowed = windowKeys.includes(yesterday) && LIMITS.MANUAL_BACKFILL_DAYS >= 1;

  const requestedDay = typeof params.day === 'string' ? params.day : '';
  const initialDay = requestedDay === yesterday && yesterdayAllowed ? yesterday : today;

  const addEntry = useAddEntry(id);
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [proofUrl, setProofUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/(app)/(tabs)'));

  // a link without an id leaves the query disabled, so the spinner would never end
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <EmptyState
          emoji="🫥"
          title="Çelinç bulunamadı"
          subtitle="Bu bağlantıda çelinç numarası yok. Çelinci açıp oradan giriş yap."
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  if (query.isPending) {
    return (
      <Screen contentStyle={styles.center}>
        <Loading label="Çelinç yükleniyor..." />
      </Screen>
    );
  }

  if (query.isError || !detail || !type) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <EmptyState
          emoji="🫥"
          title="Giriş yapılamıyor"
          subtitle={
            query.isError ? errorText(query.error, 'Çelinç bilgisi gelmedi.') : 'Bu çelincin tipi tanınmadı.'
          }
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  const { challenge } = detail;
  const selectedDay = dayKey ?? initialDay;
  const proofRequired = challenge.proofRequired || type.proofRequired;
  const emphasiseProof = proofRequired || params.proof === '1' || type.metricType === 'manual_lower_is_better';
  const value = parseValue(raw);
  const chips = quickAdds(type.maxPerEntry);
  const notActive = challenge.status !== 'active';
  const notPlaying = detail.me?.status !== 'accepted';

  const bump = (delta: number) => {
    const next = Math.min(type.maxPerEntry, (value ?? 0) + delta);
    setRaw(String(next).replace('.', ','));
    setError(null);
  };

  const pick = async (from: 'camera' | 'library') => {
    setError(null);
    try {
      if (from === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          toast({ title: 'Kamera izni yok', body: 'Ayarlardan kamerayı aç, sonra dene.', kind: 'danger' });
          return;
        }
      } else if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          toast({ title: 'Galeri izni yok', body: 'Ayarlardan fotoğraf iznini aç.', kind: 'danger' });
          return;
        }
      }

      const result =
        from === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;

      setUploading(true);
      const url = await uploadProof(api, asset);
      setProofUrl(url);
      toast({ title: 'Kanıt yüklendi', body: 'Fotoğraf girişe eklendi.', kind: 'success' });
    } catch (err) {
      toast({ title: 'Fotoğraf gitmedi', body: errorText(err, 'Yükleme başarısız.'), kind: 'danger' });
    } finally {
      setUploading(false);
    }
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
      setError('Sıfır girişin kimseye faydası yok.');
      return;
    }
    if (proofRequired && !proofUrl) {
      setError(t('proof_needed', level));
      return;
    }
    try {
      await addEntry.mutateAsync({
        dayKey: selectedDay,
        value,
        source: 'manual',
        note: note.trim() ? note.trim() : undefined,
        proofUrl: proofUrl ?? undefined,
        clientTime: new Date().toISOString(),
      });
      toast({
        title: 'Yazıldı',
        body: `${formatNumber(value)} ${type.unitTr} · ${selectedDay === today ? 'bugün' : 'dün'}`,
        kind: 'success',
      });
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

      {notActive || notPlaying ? (
        <Card edgeColor={Colors.danger}>
          <Text variant="small">
            {notActive
              ? 'Bu çelinç şu an aktif değil, giriş kabul edilmiyor.'
              : 'Bu çelinçte oyuncu değilsin, giriş yapamazsın.'}
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
      </Card>

      {/* --------------------------------------------------------- day */}
      <Card>
        <Text variant="label" style={styles.label}>
          Hangi gün
        </Text>
        {yesterdayAllowed ? (
          <SegmentedControl
            options={[
              { value: today, label: 'Bugün' },
              { value: yesterday, label: 'Dün' },
            ]}
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

        {proofUrl ? (
          <View style={styles.proofWrap}>
            <Image
              source={{ uri: absoluteUrl(proofUrl, serverUrl) }}
              style={styles.proofPreview}
              contentFit="cover"
              transition={120}
            />
            <Button
              title="Fotoğrafı kaldır"
              variant="ghost"
              size="sm"
              onPress={() => setProofUrl(null)}
            />
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
        disabled={uploading || notActive || notPlaying}
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
});
