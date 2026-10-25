import type { ReactElement } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Chip } from '@/components/Chip';
import { formatRemaining } from '@/components/Countdown';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';

/** Collects every string rendered anywhere in the tree. */
function textIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return textIn((node as { children: unknown }).children);
  }
  return [];
}

describe('TauntBubble', () => {
  it('renders the title, body and sender', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(
        <TauntBubble
          title="KOYDUM MU?"
          body="Mustafa sana sapır sapır sapladı 🍆 12.430 adım karşısında 4.201 adım."
          fromName="Mustafa"
          fromEmoji="🍆"
          timeLabel="az önce"
          loud
        />
      );
    });
    const strings = textIn(tree!.toJSON()).join(' ');
    expect(strings).toContain('KOYDUM MU?');
    expect(strings).toContain('12.430');
    expect(strings).toContain('Mustafa');
    expect(strings).toContain('az önce');
  });

  it('renders without a sender', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<TauntBubble title="Sonuç geldi!" body="Rövanş?" />);
    });
    expect(textIn(tree!.toJSON()).join(' ')).toContain('SONUÇ GELDİ!');
  });
});

describe('Chip', () => {
  /** the native views a screen reader would announce as buttons */
  const buttonsIn = (tree: ReactTestRenderer) =>
    tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');

  it('shows the label and icon', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<Chip label="ÖNDESİN" icon="🔥" filled color="#2EE59D" />);
    });
    const strings = textIn(tree!.toJSON()).join(' ');
    expect(strings).toContain('ÖNDESİN');
    expect(strings).toContain('🔥');
    // nothing to press, so nothing announced as a button
    expect(buttonsIn(tree!)).toHaveLength(0);
  });

  it('reaches past its 22-27 dp to a fingertip, and says when it is the chosen one', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<Chip label="7 gün" selected onPress={() => {}} />);
    });
    const [button] = buttonsIn(tree!);
    // vertically no further than the 8 dp gap between wrapped chip rows
    expect(button!.props.hitSlop).toEqual({ top: 8, bottom: 8, left: 4, right: 4 });
    expect(button!.props.accessibilityState).toMatchObject({ selected: true });
    expect(button!.props.accessibilityLabel).toBe('7 gün');

    act(() => {
      tree!.update(<Chip label="Kanıt ekle" icon="📸" onPress={() => {}} />);
    });
    const [plain] = buttonsIn(tree!);
    expect(plain!.props.accessibilityState).toMatchObject({ selected: false });
    expect(plain!.props.accessibilityLabel).toBe('📸 Kanıt ekle');
  });
});

describe('keyboard avoidance', () => {
  const SAFE_AREA = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 24, left: 0, right: 0, bottom: 48 },
  };

  let os: jest.ReplaceProperty<typeof Platform.OS> | null = null;
  afterEach(() => {
    os?.restore();
    os = null;
  });

  /** behavior and offset of every KeyboardAvoidingView the element renders */
  function avoiders(element: ReactElement): { behavior?: string; keyboardVerticalOffset?: number }[] {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<SafeAreaProvider initialMetrics={SAFE_AREA}>{element}</SafeAreaProvider>);
    });
    const found = tree.root
      .findAllByType(KeyboardAvoidingView)
      .map(({ props }) => ({ behavior: props.behavior, keyboardVerticalOffset: props.keyboardVerticalOffset }));
    act(() => {
      tree.unmount();
    });
    return found;
  }

  const screen = (
    <Screen keyboard>
      <Text>Şifre</Text>
    </Screen>
  );
  const sheet = (
    <Sheet visible onClose={() => {}} title="Şifreni değiştir">
      <Text>Şifre</Text>
    </Sheet>
  );

  // Android is edge-to-edge, so the window no longer shrinks for the keyboard:
  // without 'padding' the fields and the sheets stayed under it
  it('pads a form and a sheet clear of the keyboard on Android', () => {
    os = jest.replaceProperty(Platform, 'OS', 'android');
    // the frame is already measured below insets.top; adding it again lifted the form too far
    expect(avoiders(screen)).toStrictEqual([{ behavior: 'padding', keyboardVerticalOffset: 0 }]);
    expect(avoiders(sheet)).toStrictEqual([{ behavior: 'padding', keyboardVerticalOffset: undefined }]);
  });

  it('keeps the iOS offset for the page-sheet modals', () => {
    expect(Platform.OS).toBe('ios');
    expect(avoiders(screen)).toStrictEqual([{ behavior: 'padding', keyboardVerticalOffset: 24 }]);
    expect(avoiders(sheet)).toStrictEqual([{ behavior: 'padding', keyboardVerticalOffset: undefined }]);
  });

  it('leaves the web to the browser', () => {
    os = jest.replaceProperty(Platform, 'OS', 'web');
    expect(avoiders(screen)).toStrictEqual([{ behavior: undefined, keyboardVerticalOffset: 0 }]);
    expect(avoiders(sheet)).toStrictEqual([{ behavior: undefined, keyboardVerticalOffset: undefined }]);
  });
});

describe('ProgressBar', () => {
  it('clamps the fill between 0 and 100 percent', () => {
    const widths: string[] = [];
    for (const value of [-1, 0, 0.5, 1, 4, Number.NaN]) {
      let tree: ReactTestRenderer;
      act(() => {
        tree = create(<ProgressBar value={value} />);
      });
      const json = tree!.toJSON() as { children?: { props?: { style?: { width?: string } } }[] } | null;
      widths.push(json?.children?.[0]?.props?.style?.width ?? '');
    }
    expect(widths).toEqual(['0%', '0%', '50%', '100%', '100%', '0%']);
  });
});

describe('formatRemaining', () => {
  it('drops to the biggest two units', () => {
    expect(formatRemaining(2 * 86400_000 + 4 * 3600_000)).toBe('2g 4sa');
    expect(formatRemaining(3 * 3600_000 + 12 * 60_000)).toBe('3sa 12dk');
    expect(formatRemaining(90_000)).toBe('1dk 30sn');
    expect(formatRemaining(9_000)).toBe('9sn');
    expect(formatRemaining(-5)).toBe('0sn');
  });
});

describe('Text line height fits the font size', () => {
  function styleOf(element: React.ReactElement): { fontSize?: number; lineHeight?: number } {
    let node!: ReactTestRenderer;
    act(() => {
      node = create(element);
    });
    const rendered = node.toJSON() as unknown as { props: { style: unknown } };
    return StyleSheet.flatten(rendered.props.style as never) as {
      fontSize?: number;
      lineHeight?: number;
    };
  }

  it('grows the line box when a style bumps fontSize and says nothing else', () => {
    const style = styleOf(<Text style={{ fontSize: 36 }}>KOY123</Text>);
    expect(style.fontSize).toBe(36);
    // the inherited body line height (22.4) would slice the glyphs in half
    expect(style.lineHeight).toBeGreaterThanOrEqual(36);
  });

  it('leaves an explicit lineHeight alone', () => {
    const style = styleOf(<Text style={{ fontSize: 36, lineHeight: 60 }}>KOY123</Text>);
    expect(style.lineHeight).toBe(60);
  });

  it('keeps every variant roomy enough for Turkish caps (\u0130, \u011e, \u015e)', () => {
    for (const variant of ['giant', 'huge', 'big', 'title', 'lead', 'body'] as const) {
      const style = styleOf(<Text variant={variant}>ÇELİNÇ ĞİŞ</Text>);
      const ratio = (style.lineHeight ?? 0) / (style.fontSize ?? 1);
      expect({ variant, ok: ratio >= 1.15 }).toEqual({ variant, ok: true });
    }
  });
});
