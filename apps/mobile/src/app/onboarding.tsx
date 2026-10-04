import { t, type VulgarityLevel } from '@koydum/shared';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { registerForPush } from '@/services/notifications';
import { requestStepPermission } from '@/services/steps';
import { useAuth, useLevel } from '@/store/auth';
import { Colors, Layout, Radius, Spacing } from '@/theme';

interface Slide {
  key: 'onboarding_1' | 'onboarding_2' | 'onboarding_3' | 'onboarding_4';
  art: string;
  titles: Record<VulgarityLevel, string>;
  /** the slide that asks for the two permissions instead of only talking */
  permissions?: true;
}

/** undefined until asked; then whether the phone said yes */
type Answers = { push?: boolean; steps?: boolean };

const SLIDES: Slide[] = [
  {
    key: 'onboarding_1',
    art: '🔥',
    titles: {
      1: 'Arkadaşlarınla yarış',
      2: 'Kankalarla çelınc aç',
      3: 'Kim kime koyacak?',
    },
  },
  {
    key: 'onboarding_2',
    art: '📊',
    titles: {
      1: 'Skorları uygulama tutar',
      2: 'Sallamak yok',
      3: 'Palavra sökmez',
    },
  },
  {
    key: 'onboarding_3',
    art: '🍆',
    titles: {
      1: 'Kazanan mesaj gönderir',
      2: 'KOYDUM MU?',
      3: 'SAPIR SAPIR 🍆',
    },
  },
  {
    key: 'onboarding_4',
    art: '🔔',
    titles: {
      1: 'İki izin lazım',
      2: 'İki izin, o kadar',
      3: 'İzinleri ver, kapışalım',
    },
    permissions: true,
  },
];

export default function OnboardingScreen() {
  const level = useLevel();
  const setOnboarding = useAuth((s) => s.setOnboarding);
  const { width: windowWidth } = useWindowDimensions();
  const scroller = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [asking, setAsking] = useState<keyof Answers | null>(null);

  const width = Math.min(windowWidth, Layout.maxWidth);
  const last = SLIDES.length - 1;
  const isLast = index === last;

  // However the slides go away (the buttons, Android's back), NotificationBridge
  // must not stay on hold: that would leave the session without push and steps.
  useEffect(() => () => setOnboarding(false), [setOnboarding]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
    if (next !== index && next >= 0 && next < SLIDES.length) setIndex(next);
  };

  const finish = () => {
    // whatever was not answered here, the bridge now asks for on the home screen
    setOnboarding(false);
    router.replace('/(app)/(tabs)');
  };

  const goTo = (target: number) => {
    setIndex(target);
    scroller.current?.scrollTo({ x: target * width, animated: true });
  };

  const next = () => {
    if (isLast) finish();
    else goTo(index + 1);
  };

  // "Geç" skips the talk, not the permissions: skipped, they would pop up on
  // the home screen with nothing to say why
  const skip = () => {
    if (isLast) finish();
    else goTo(last);
  };

  const ask = async (which: keyof Answers) => {
    setAsking(which);
    try {
      const granted = which === 'push' ? (await registerForPush()).granted : await requestStepPermission();
      setAnswers((prev) => ({ ...prev, [which]: granted }));
    } finally {
      setAsking(null);
    }
  };

  return (
    <Screen padded={false} contentStyle={styles.content}>
      <View style={styles.top}>
        <Text variant="small" color={Colors.accent} black>
          KOYDUM
        </Text>
        <Pressable accessibilityRole="button" onPress={skip} hitSlop={12}>
          <Text variant="small" muted>
            Geç
          </Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={styles.pager}
        contentContainerStyle={styles.pagerContent}>
        {SLIDES.map((slide) => (
          <View key={slide.key} style={[styles.slide, { width }]}>
            {/* a smaller picture on the permission slide, so its two buttons fit a small phone */}
            <View style={[styles.artWrap, slide.permissions && styles.artWrapSmall]}>
              <Text style={[styles.art, slide.permissions && styles.artSmall]}>{slide.art}</Text>
            </View>
            <Text variant="huge" center style={styles.title}>
              {slide.titles[level]}
            </Text>
            <Text variant="lead" muted center>
              {t(slide.key, level)}
            </Text>
            {slide.permissions ? (
              <View style={styles.permissions}>
                {answers.push ? (
                  <Chip icon="✅" label="Bildirim izni verildi" color={Colors.success} style={styles.granted} />
                ) : (
                  <Button
                    title="Bildirim izni"
                    icon="🔔"
                    variant="secondary"
                    fullWidth
                    loading={asking === 'push'}
                    disabled={asking !== null}
                    onPress={() => void ask('push')}
                  />
                )}
                {answers.steps ? (
                  <Chip icon="✅" label="Adım izni verildi" color={Colors.success} style={styles.granted} />
                ) : (
                  <Button
                    title="Adım izni"
                    icon="🚶"
                    variant="secondary"
                    fullWidth
                    loading={asking === 'steps'}
                    disabled={asking !== null}
                    onPress={() => void ask('steps')}
                  />
                )}
                {answers.push === false || answers.steps === false ? (
                  <Text variant="tiny" faint center>
                    Vermezsen de olur, sonra Ayarlar’dan açarsın.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>

      <View style={styles.dots}>
        {SLIDES.map((slide, i) => (
          <View key={slide.key} style={[styles.dot, i === index && styles.dotActive]} />
        ))}
      </View>

      <View style={styles.footer}>
        <Button
          title={isLast ? 'BAŞLAYALIM' : 'DEVAM'}
          size="lg"
          fullWidth
          onPress={next}
          icon={isLast ? '🚀' : undefined}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: Spacing.xl },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
  },
  pager: { flex: 1 },
  pagerContent: { alignItems: 'stretch' },
  slide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
  },
  artWrap: {
    width: 168,
    height: 168,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  artWrapSmall: { width: 112, height: 112, marginBottom: Spacing.sm },
  art: { fontSize: 92, lineHeight: 108 },
  artSmall: { fontSize: 60, lineHeight: 72 },
  title: { color: Colors.text },
  permissions: { alignSelf: 'stretch', gap: Spacing.sm, marginTop: Spacing.md },
  granted: { alignSelf: 'center' },
  dots: { flexDirection: 'row', gap: Spacing.sm, justifyContent: 'center', paddingVertical: Spacing.lg },
  dot: { width: 8, height: 8, borderRadius: Radius.pill, backgroundColor: Colors.border },
  dotActive: { width: 26, backgroundColor: Colors.accent },
  footer: {
    paddingHorizontal: Spacing.lg,
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
  },
});
