import type { ChallengeType, ParticipantView, TauntContext, TauntTemplate, TauntVars, VulgarityLevel } from '@koydum/shared';
import {
  LIMITS,
  containsBanned,
  formatNumberTr,
  getChallengeType,
  renderTaunt,
  scoreLabel,
  t,
  tauntContextForMargin,
  tauntsAtLevel,
  winMargin,
} from '@koydum/shared';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Chip } from '@/components/Chip';
import { EmptyState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { Skeleton } from '@/components/Loading';
import { Screen } from '@/components/Screen';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { useChallenge, useResults, useTaunt } from '@/hooks/queries';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Radius, Spacing } from '@/theme';
import { errorText } from '@/utils/errors';
import { CUSTOM_TAUNT_CEILING_NOTE, byLevel } from '@/utils/levelCopy';

/* ------------------------------------------------------------------- copy */

const LEVEL_LABEL: Record<VulgarityLevel, string> = {
  1: 'Nazik',
  2: 'Argo',
  3: 'Ağır Abi',
};

const CONTEXT_LABEL: Record<string, string> = {
  win: 'NORMAL FARK',
  win_big: 'EZİCİ FARK',
  win_close: 'KIL PAYI',
  tie: 'BERABERE',
};

/**
 * The recipient's ceiling is not on the wire, so we explain the clamp instead
 * of drawing the locked templates. It only covers the ready-made copy: a
 * sentence the sender types is delivered word for word (see the custom field).
 */
const CEILING_NOTE: Record<VulgarityLevel, string> = {
  1: 'Not: Alıcı daha nazik bir seviye seçtiyse sunucu bu hazır lafı ona göre yumuşatır, yani birebir bu metin gitmeyebilir.',
  2: 'Not: Karşı taraf daha yumuşak seviyedeyse sunucu hazır lafı ona göre kısar — birebir bu metin gitmeyebilir.',
  3: 'Not: Kaldıramayacaksa sunucu hazır lafı otomatik yumuşatır 🍆 Birebir bu metin gitmeyebilir.',
};

const BANNED_WARNING: Record<VulgarityLevel, string> = {
  1: 'Bu ifadeyi gönderemem: aile, tehdit ve nefret söylemi yasak. Başka türlü yaz.',
  2: 'Öyle olmaz lan: aile, tehdit ve nefret söylemi yasak. Kankana sok, ailesine değil.',
  3: 'Dur bakalım: aileye, tehdide ve nefrete izin yok. Ona sapla, ailesine değil 🍆',
};

const CUSTOM_LABEL: Record<VulgarityLevel, string> = {
  1: 'Kendi lafını yaz',
  2: 'Kendi lafını yaz',
  3: 'Kendi lafını yaz 🍆',
};

const CUSTOM_PLACEHOLDER: Record<VulgarityLevel, string> = {
  1: 'Kendi cümlenle yaz...',
  2: 'Ne diyeceksen yaz lan...',
  3: 'Sapla bakalım, kendi lafınla...',
};

const SEND_LABEL: Record<VulgarityLevel, string> = {
  1: 'GÖNDER',
  2: 'GÖNDER',
  3: 'GÖNDER 🍆',
};

const NOT_WINNER: Record<VulgarityLevel, string> = {
  1: 'Mesaj gönderme hakkı kazananın.',
  2: 'Laf sokma hakkı kazananın lan. Sen bu çelinci kazanmadın.',
  3: 'Koyma hakkı kazananın 🍆 Sen kazanmadın, sıraya gir.',
};

const customTitleFor = (level: VulgarityLevel, name: string): string => {
  if (level === 1) return `${name} bir not bıraktı`;
  if (level === 3) return `${name} KOYDU 🍆`;
  return `${name} laf soktu`;
};

/* ------------------------------------------------------------------ utils */

/* ----------------------------------------------------------------- screen */

export default function TauntPickerScreen() {
  const params = useLocalSearchParams<{ id: string; to?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const toParam = typeof params.to === 'string' ? params.to : '';
  const level = useLevel();
  const me = useAuth((s) => s.me);
  const meId = me?.id ?? null;

  const query = useResults(id);
  // canTaunt is the authority on who already got one; it is normally cached
  const detail = useChallenge(id);
  const send = useTaunt(id);

  const [pickedTarget, setPickedTarget] = useState<string>(toParam && toParam !== 'all' ? toParam : '');
  const [allMode, setAllMode] = useState<boolean>(toParam === 'all');
  const [tauntLevel, setTauntLevel] = useState<VulgarityLevel>(level);
  const [templateId, setTemplateId] = useState<string>('');
  const [custom, setCustom] = useState<string>('');
  const [useCustom, setUseCustom] = useState<boolean>(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<boolean>(false);
  /** names of everyone the taunt actually reached, kept so the confirmation
   *  survives the refetch that removes them from the target list */
  const [sentNames, setSentNames] = useState<string[]>([]);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/challenge/[id]/results', params: { id } });
  };

  // the confirmation stays on screen for a beat, then we drop back to the results
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: '/challenge/[id]/results', params: { id } });
    }, 1700);
    return () => clearTimeout(timer);
  }, [id, sent]);

  // the confirmation wins over every other state: the send already invalidated
  // the queries underneath us and the target list is about to shrink
  if (sent) {
    return (
      <Screen glow contentStyle={styles.sentWrap}>
        <Text style={styles.sentEmoji}>{level === 1 ? '📨' : '🍆'}</Text>
        <Text variant="big" center>
          {t('taunt_sent_confirmation', level)}
        </Text>
        <Text variant="small" muted center>
          {sentNames.length > 1
            ? `${sentNames.length} kişiye gitti: ${sentNames.join(', ')}`
            : `${sentNames[0] ?? 'Kanka'} bildirimi aldı.`}
        </Text>
        <Text variant="tiny" faint center>
          Hazır laf seçtiysen, alıcının seviyesi daha düşükse metin ona göre yumuşatılmış olabilir.
        </Text>
        <Button title="Kapat" variant="ghost" size="md" style={styles.sentBtn} onPress={close} />
      </Screen>
    );
  }

  // a link without an id leaves the query disabled: guard before the skeleton
  if (!id) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header title="Laf seç" onClose={close} />
        <EmptyState
          emoji="🫥"
          title="Çelinç bulunamadı"
          subtitle="Bu bağlantıda çelinç numarası yok. Sonuç ekranından laf seç."
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  if (query.isPending) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header title="Laf seç" onClose={close} />
        <Skeleton height={70} style={styles.block} />
        <Skeleton height={120} style={styles.block} />
        <Skeleton height={120} style={styles.block} />
      </Screen>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header title="Laf seç" onClose={close} />
        <EmptyState
          emoji="📡"
          title="Sonuç gelmedi"
          subtitle={errorText(query.error, 'Sunucuya ulaşamadım.')}
          actionLabel="Tekrar dene"
          onAction={() => void query.refetch()}
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
        <Header title="Laf seç" onClose={close} />
        <EmptyState
          emoji="⏳"
          title="Çelinç daha bitmedi"
          subtitle="Bitmeden laf yok. Önce skoru yap, sonra konuş."
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  if (!meId || challenge.winnerId !== meId) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header title="Laf seç" onClose={close} />
        <EmptyState
          emoji={challenge.isTie ? '🤝' : '🤐'}
          title={challenge.isTie ? 'Berabere bitti' : 'Bu hak sende değil'}
          subtitle={challenge.isTie ? 'Kimse kazanmadı, kimse laf sokamaz. Rövanş aç.' : NOT_WINNER[level]}
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  const mine = standings.find((p) => p.user.id === meId);
  const myScore = mine?.score ?? 0;
  const myName = mine?.user.displayName ?? me?.displayName ?? 'Kazanan';

  const losers = standings.filter(
    (p) => p.status === 'accepted' && p.user.id !== meId && !p.isWinner
  );
  const taunted = new Set<string>();
  for (const row of detail.data?.canTaunt ?? []) if (row.done) taunted.add(row.toUserId);
  for (const done of taunts) if (done.fromUserId === meId) taunted.add(done.toUserId);
  const available = losers.filter((p) => !taunted.has(p.user.id));

  if (losers.length === 0 || available.length === 0) {
    return (
      <Screen scroll contentStyle={styles.content}>
        <Header title="Laf seç" onClose={close} />
        <EmptyState
          emoji={losers.length === 0 ? '🫥' : '✅'}
          title={
            losers.length === 0
              ? 'Kaybeden yok'
              : byLevel(level, 'Hepsine gönderdin', 'Hepsine koydun', 'Hepsine sapladın 🍆')
          }
          subtitle={
            losers.length === 0
              ? byLevel(
                  level,
                  'Bu çelinçte mesaj gönderecek kimse kalmamış.',
                  'Bu çelinçte laf sokacak kimse kalmamış.',
                  'Bu çelinçte saplayacak kimse kalmamış 🍆'
                )
              : byLevel(
                  level,
                  'Herkese bir kere gönderdin. İkincisi yok.',
                  'Herkese bir kere koydun. İkincisi yok, sofra kapandı.',
                  'Herkese bir kere sapladın. İkincisi yok, sofra kapandı.'
                )
          }
          actionLabel="Kapat"
          onAction={close}
        />
      </Screen>
    );
  }

  /** In "HEPSİ" mode this is the loser the preview is drawn for. */
  const chosen: ParticipantView | undefined =
    available.find((p) => p.user.id === pickedTarget) ??
    (allMode || available.length === 1 ? available[0] : undefined);
  const recipients = allMode ? available : chosen ? [chosen] : [];

  /** Everybody finished with their own gap, so everybody gets their own context. */
  const contextFor = (participant: ParticipantView): TauntContext =>
    challenge.isTie
      ? 'tie'
      : tauntContextForMargin(
          winMargin({ direction: challenge.direction }, myScore, participant.score)
        );

  const theirScore = chosen?.score ?? 0;
  const context: TauntContext = chosen ? contextFor(chosen) : challenge.isTie ? 'tie' : 'win';
  const templates = tauntsAtLevel(context, tauntLevel);
  const active: TauntTemplate | undefined =
    templates.find((tpl) => tpl.id === templateId) ?? templates[0];

  /**
   * The template picked for the previewed loser is written for THEIR gap. Send
   * the same one to somebody who finished a mile behind and the "kıl payı" copy
   * lands on a player who scored nothing, so each recipient gets the same
   * position in the pool of their own context instead.
   */
  const templateForRecipient = (target: ParticipantView): string | undefined => {
    if (!active) return undefined;
    const targetContext = contextFor(target);
    if (targetContext === context) return active.id;
    const pool = tauntsAtLevel(targetContext, tauntLevel);
    if (pool.length === 0) return undefined; // no match: let the server pick
    const index = Math.max(0, templates.findIndex((tpl) => tpl.id === active.id));
    return pool[index % pool.length].id;
  };
  /** true when at least one other recipient will get a different template */
  const mixedContexts = recipients.some((target) => contextFor(target) !== context);

  const vars: TauntVars = {
    winner: myName,
    loser: chosen?.user.displayName ?? 'kanka',
    metric: type?.nameTr ?? challenge.unit,
    winnerScore: formatNumberTr(myScore),
    loserScore: formatNumberTr(theirScore),
    diff: formatNumberTr(Math.abs(myScore - theirScore)),
    unit: challenge.unit,
    challenge: challenge.title || type?.nameTr || 'çelinç',
  };

  const customText = custom.trim();
  const banned = customText.length > 0 && containsBanned(customText);
  const preview =
    useCustom
      ? { title: customTitleFor(tauntLevel, myName), body: customText }
      : active
        ? renderTaunt(active, vars)
        : null;
  const canSend =
    recipients.length > 0 && (useCustom ? customText.length > 0 && !banned : !!active) && !send.isPending;

  const submit = async () => {
    if (!canSend) return;
    setFailed(null);
    if (!useCustom && !active) return;

    const delivered: string[] = [];
    const errors: string[] = [];
    for (const target of recipients) {
      const payload = useCustom
        ? { customBody: customText }
        : { templateId: templateForRecipient(target) };
      try {
        await send.mutateAsync({ toUserId: target.user.id, ...payload });
        delivered.push(target.user.displayName);
      } catch (error) {
        errors.push(`${target.user.displayName}: ${errorText(error, 'gönderilemedi')}`);
      }
    }

    if (errors.length === 0 && delivered.length > 0) {
      if (Platform.OS !== 'web') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setSentNames(delivered);
      setSent(true);
      return;
    }
    // partial delivery: stay here so the ones that failed can be retried
    setFailed(
      [
        delivered.length > 0
          ? `${delivered.length} kişiye gitti, gerisi olmadı:`
          : 'Gönderilemedi:',
        ...errors,
      ].join('\n')
    );
  };

  return (
    <Screen scroll keyboard contentStyle={styles.content} bottomInset={Spacing.xxl}>
      <Header title={t('taunt_picker_title', level)} onClose={close} />

      {/* --------------------------------------------------------- target */}
      <Card>
        <Text variant="label" style={styles.sectionLabel}>
          Kime
        </Text>
        {available.length > 1 ? (
          <View style={styles.chipRow}>
            {available.map((loser) => (
              <Chip
                key={loser.user.id}
                label={loser.user.displayName}
                icon={loser.user.avatarEmoji}
                color={Colors.accent}
                selected={!allMode && chosen?.user.id === loser.user.id}
                onPress={() => {
                  setAllMode(false);
                  setPickedTarget(loser.user.id);
                }}
              />
            ))}
            <Chip
              label={`HEPSİ (${available.length})`}
              icon="🍆"
              color={Colors.yellow}
              selected={allMode}
              onPress={() => setAllMode(true)}
            />
          </View>
        ) : null}

        {chosen ? (
          <View style={[styles.targetRow, available.length > 1 && styles.gap]}>
            <Avatar
              emoji={allMode ? '🍆' : chosen.user.avatarEmoji}
              name={chosen.user.displayName}
              size={40}
              ring={Colors.accent}
            />
            <View style={styles.grow}>
              <Text variant="small" bold numberOfLines={1}>
                {allMode
                  ? available.map((p) => p.user.displayName).join(', ')
                  : chosen.user.displayName}
              </Text>
              <Text variant="tiny" muted numberOfLines={1}>
                Sen {scoreText(myScore)} · {allMode ? `${chosen.user.displayName}` : 'o'}{' '}
                {scoreText(theirScore)}
              </Text>
            </View>
            <Chip
              label={CONTEXT_LABEL[context] ?? 'FARK'}
              color={context === 'win_big' ? Colors.success : context === 'win_close' ? Colors.yellow : Colors.textMuted}
              size="sm"
            />
          </View>
        ) : (
          <Text variant="small" muted>
            Önce kime koyacağını seç.
          </Text>
        )}

        {allMode ? (
          <Text variant="tiny" faint style={styles.gap}>
            {mixedContexts
              ? `Herkese ayrı ayrı gider ve laf herkesin kendi farkına göre seçilir. Aşağıdaki önizleme ${chosen?.user.displayName ?? 'ilk kişi'} için.`
              : `Aynı laf hepsine ayrı ayrı gider, skorlar herkesin kendi skoruyla yazılır. Önizleme ${chosen?.user.displayName ?? 'ilk kişi'} için.`}
          </Text>
        ) : null}
      </Card>

      {!chosen ? (
        <Card>
          <Text variant="small" muted>
            Yukarıdan kime koyacağını seç, laflar o kişinin skoruyla burada çıksın.
          </Text>
        </Card>
      ) : null}

      {/* ------------------------------------------------------ templates */}
      {chosen ? (
        <>
          <Card>
            <View style={styles.sectionHead}>
              <Text variant="label">Hazır laflar</Text>
              <Text variant="micro" faint>
                {templates.length} seçenek
              </Text>
            </View>

            {level > 1 ? (
              <SegmentedControl<VulgarityLevel>
                style={styles.gapSm}
                value={tauntLevel}
                onChange={(next) => {
                  setTauntLevel(next);
                  setTemplateId('');
                }}
                options={([1, 2, 3] as VulgarityLevel[])
                  .filter((value) => value <= level)
                  .map((value) => ({ value, label: LEVEL_LABEL[value] }))}
              />
            ) : null}

            <View style={styles.templateList}>
              {templates.map((template) => {
                const rendered = renderTaunt(template, vars);
                const selected = !useCustom && active?.id === template.id;
                return (
                  <Pressable
                    key={template.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      setTemplateId(template.id);
                      setUseCustom(false);
                    }}
                    style={[styles.template, selected && styles.templateSelected]}>
                    <View style={styles.templateHead}>
                      <Text variant="small" bold numberOfLines={1} style={styles.grow}>
                        {rendered.title}
                      </Text>
                      <Text variant="micro" color={selected ? Colors.accent : Colors.textFaint}>
                        {selected ? '✓ SEÇİLİ' : `SEVİYE ${template.level}`}
                      </Text>
                    </View>
                    <Text variant="small" muted={!selected}>
                      {rendered.body}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text variant="tiny" faint style={styles.gap}>
              {CEILING_NOTE[level]}
            </Text>
          </Card>

          {/* --------------------------------------------------------- custom */}
          <Card edgeColor={useCustom ? Colors.accent : undefined}>
            <Input
              label={CUSTOM_LABEL[level]}
              placeholder={CUSTOM_PLACEHOLDER[level]}
              value={custom}
              onChangeText={(text) => {
                setCustom(text);
                setUseCustom(text.trim().length > 0);
              }}
              multiline
              maxLength={LIMITS.CUSTOM_TAUNT_MAX}
              style={styles.customInput}
              error={banned ? BANNED_WARNING[level] : null}
              hint={`${custom.length}/${LIMITS.CUSTOM_TAUNT_MAX} · yazarsan hazır laf yerine bu gider`}
            />
            <Text variant="tiny" color={Colors.yellow} style={styles.gapSm}>
              ⚠️ {CUSTOM_TAUNT_CEILING_NOTE}
            </Text>
            {useCustom && !banned ? (
              <Button
                title="Vazgeç, hazır laf kullan"
                variant="ghost"
                size="sm"
                style={styles.gapSm}
                onPress={() => {
                  setUseCustom(false);
                  setCustom('');
                }}
              />
            ) : null}
          </Card>

          {/* -------------------------------------------------------- preview */}
          <View style={styles.previewWrap}>
            <Text variant="label">
              {allMode && chosen ? `Önizleme · ${chosen.user.displayName}` : 'Önizleme'}
            </Text>
            {preview && (preview.body.length > 0 || !useCustom) ? (
              <TauntBubble
                loud
                title={preview.title}
                body={preview.body}
                fromName={myName}
                fromEmoji={me?.avatarEmoji}
                timeLabel="şimdi"
              />
            ) : (
              <Card>
                <Text variant="small" muted>
                  Bir laf seç ya da kendi cümleni yaz — burada göreceksin. Hazır lafları sunucu
                  alıcının seviyesine göre yumuşatabilir; kendi yazdığın cümle aynen gider.
                </Text>
              </Card>
            )}
          </View>

          {failed ? (
            <Text variant="small" color={Colors.danger}>
              {failed}
            </Text>
          ) : null}

          <Button
            title={SEND_LABEL[level]}
            icon="🚀"
            size="xl"
            fullWidth
            disabled={!canSend}
            loading={send.isPending}
            onPress={() => void submit()}
          />
        </>
      ) : null}

      <Button title="Vazgeç" variant="ghost" size="md" fullWidth onPress={close} />
    </Screen>
  );
}

/* ----------------------------------------------------------------- pieces */

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View style={styles.header}>
      <Text variant="title" numberOfLines={2} style={styles.grow}>
        {title}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Kapat" onPress={onClose} style={styles.closeBtn}>
        <Text variant="lead">✕</Text>
      </Pressable>
    </View>
  );
}

/* ----------------------------------------------------------------- styles */

const styles = StyleSheet.create({
  content: { gap: Spacing.lg, paddingVertical: Spacing.lg },
  block: { borderRadius: Radius.lg },
  grow: { flex: 1 },
  gap: { marginTop: Spacing.md },
  gapSm: { marginTop: Spacing.sm },

  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },

  sectionLabel: { marginBottom: Spacing.md },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },

  templateList: { marginTop: Spacing.md, gap: Spacing.sm },
  template: {
    backgroundColor: Colors.surfaceHigh,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: 4,
  },
  templateSelected: { borderColor: Colors.accent, backgroundColor: 'rgba(255,61,113,0.10)' },
  templateHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },

  customInput: { minHeight: 84, textAlignVertical: 'top' },

  previewWrap: { gap: Spacing.sm },

  sentWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md },
  sentEmoji: { fontSize: 64 },
  sentBtn: { marginTop: Spacing.lg },
});
