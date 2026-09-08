import { t, type VulgarityLevel } from '@koydum/shared';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
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
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { StorageKeys, setJson } from '@/lib/storage';
import { useLevel } from '@/store/auth';
import { Colors, Layout, Radius, Spacing } from '@/theme';

interface Slide {
  key: 'onboarding_1' | 'onboarding_2' | 'onboarding_3';
  art: string;
  titles: Record<VulgarityLevel, string>;
}

const SLIDES: Slide[] = [
  {
    key: 'onboarding_1',
    art: '🔥',
    titles: {
      1: 'Arkadaşlarınla yarış',
      2: 'Kankalarla çelinç aç',
      3: 'Kim kime koyacak?',
    },
  },
  {
    key: 'onboarding_2',
    art: '📊',
    titles: {
      1: 'Skorlar sayılır',
      2: 'Skor tutuluyor lan',
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
];

export default function OnboardingScreen() {
  const level = useLevel();
  const { width: windowWidth } = useWindowDimensions();
  const scroller = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);

  const width = Math.min(windowWidth, Layout.maxWidth);
  const isLast = index === SLIDES.length - 1;

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
    if (next !== index && next >= 0 && next < SLIDES.length) setIndex(next);
  };

  const finish = async () => {
    await setJson(StorageKeys.onboarded, true);
    router.replace('/(app)/(tabs)');
  };

  const next = () => {
    if (isLast) {
      void finish();
      return;
    }
    const target = index + 1;
    setIndex(target);
    scroller.current?.scrollTo({ x: target * width, animated: true });
  };

  return (
    <Screen padded={false} contentStyle={styles.content}>
      <View style={styles.top}>
        <Text variant="small" color={Colors.accent} black>
          KOYDUM
        </Text>
        <Pressable accessibilityRole="button" onPress={() => void finish()} hitSlop={12}>
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
            <View style={styles.artWrap}>
              <Text style={styles.art}>{slide.art}</Text>
            </View>
            <Text variant="huge" center style={styles.title}>
              {slide.titles[level]}
            </Text>
            <Text variant="lead" muted center>
              {t(slide.key, level)}
            </Text>
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
  pagerContent: { alignItems: 'center' },
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
  art: { fontSize: 92, lineHeight: 108 },
  title: { color: Colors.text },
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
