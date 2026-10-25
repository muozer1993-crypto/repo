import { NavigationContext } from 'expo-router/react-navigation';
import { useEffect, useState, type ReactElement } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Chip } from '@/components/Chip';
import { formatRemaining } from '@/components/Countdown';
import { OfflineFrame } from '@/components/OfflineBanner';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { TauntBubble } from '@/components/TauntBubble';
import { Text } from '@/components/Text';
import { ToastProvider, useToast } from '@/components/Toast';
import { Spacing } from '@/theme';

/** What the /health probe says; the real hook would poll the network. */
const mockConnection = { online: true, checked: true, longOffline: false };

jest.mock('@/hooks/useConnection', () => ({
  useConnection: () => ({ ...mockConnection, lastOkAt: null, retry: () => {} }),
}));

jest.mock('@/store/auth', () => ({
  useAuth: (selector: (state: { token: string | null }) => unknown) => selector({ token: 'token' }),
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

// The JS driver, so a test can read where a fade got to (the native one runs off the JS thread).
jest.mock('@/utils/animation', () => ({ ...jest.requireActual('@/utils/animation'), USE_NATIVE_DRIVER: false }));

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
    // A chip row's gap (Spacing.sm, both ways) holds one chip's slop on one
    // side plus its neighbour's on the other, beside it or in the row below:
    // more and a tap in the overlap goes to the later chip.
    const slop = button!.props.hitSlop as { top: number; bottom: number; left: number; right: number };
    expect(slop.top).toBeGreaterThan(0);
    expect(slop.left).toBeGreaterThan(0);
    expect(slop.top + slop.bottom).toBeLessThanOrEqual(Spacing.sm);
    expect(slop.left + slop.right).toBeLessThanOrEqual(Spacing.sm);
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

describe('a toast raised while a sheet is open', () => {
  const SAFE_AREA = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 24, left: 0, right: 0, bottom: 48 },
  };

  function Raise({ label, title }: { label: string; title: string }) {
    const toast = useToast();
    return (
      <Pressable accessibilityLabel={label} onPress={() => toast({ title, kind: 'danger' })}>
        <Text>{label}</Text>
      </Pressable>
    );
  }

  function Harness({ report, more = false }: { report: boolean; more?: boolean }) {
    return (
      <SafeAreaProvider initialMetrics={SAFE_AREA}>
        <ToastProvider>
          <Raise label="Ekranda" title="Şikayet alındı" />
          <Sheet visible={more} onClose={() => {}} title="Ali" scroll={false}>
            <Raise label="Menüde" title="Kopyalandı" />
          </Sheet>
          <Sheet visible={report} onClose={() => {}} title="Şikayet et">
            <Raise label="Gönder" title="Sebep yaz" />
          </Sheet>
        </ToastProvider>
      </SafeAreaProvider>
    );
  }

  let tree: ReactTestRenderer | null = null;
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
  });

  const press = (label: string) =>
    act(() => {
      tree!.root.find((node) => typeof node.type !== 'string' && node.props.accessibilityLabel === label).props.onPress();
    });
  /** native text nodes that print exactly this, under `root` */
  const printed = (root: ReactTestInstance, text: string) =>
    root.findAll((node) => typeof node.type === 'string' && node.props.children === text);
  const modals = () => tree!.root.findAllByType(Modal);

  // A Sheet is an RN Modal, a window of its own: the root tree's toast sat
  // under its scrim, so "Sebep yaz" or "Fotoğraf gitmedi" never showed
  it('draws the toast inside the open sheet, once', () => {
    act(() => {
      tree = create(<Harness report />);
    });
    press('Gönder');
    const [, reportSheet] = modals();
    expect(printed(reportSheet!, 'Sebep yaz')).toHaveLength(1);
    expect(printed(tree!.root, 'Sebep yaz')).toHaveLength(1);
  });

  it('goes back to the app once the sheet is closed', () => {
    act(() => {
      tree = create(<Harness report />);
    });
    press('Gönder');
    act(() => tree!.update(<Harness report={false} />));
    // still on screen for the rest of its time, now drawn by the app
    expect(printed(tree!.root, 'Sebep yaz')).toHaveLength(1);

    press('Ekranda');
    expect(printed(tree!.root, 'Şikayet alındı')).toHaveLength(1);
    expect(printed(tree!.root, 'Sebep yaz')).toHaveLength(0);
    for (const modal of modals()) expect(printed(modal, 'Şikayet alındı')).toHaveLength(0);
  });

  it('is drawn by the sheet opened last, and by the one below when that closes', () => {
    act(() => {
      tree = create(<Harness report={false} more />);
    });
    act(() => tree!.update(<Harness report more />));
    press('Gönder');
    const [moreSheet, reportSheet] = modals();
    expect(printed(reportSheet!, 'Sebep yaz')).toHaveLength(1);
    expect(printed(moreSheet!, 'Sebep yaz')).toHaveLength(0);

    act(() => tree!.update(<Harness report={false} more />));
    expect(printed(modals()[0]!, 'Sebep yaz')).toHaveLength(1);
    expect(printed(tree!.root, 'Sebep yaz')).toHaveLength(1);
  });

  /** The report sheet's own flow: an empty reason is refused, a sent one closes it. */
  function ReportFlow() {
    const [open, setOpen] = useState(true);
    const toast = useToast();
    return (
      <Sheet visible={open} onClose={() => setOpen(false)} title="Şikayet et">
        <Pressable accessibilityLabel="Boş gönder" onPress={() => toast({ title: 'Sebep yaz', kind: 'danger' })} />
        <Pressable
          accessibilityLabel="Gönder"
          onPress={() => {
            setOpen(false);
            toast({ title: 'Şikayet alındı', kind: 'success' });
          }}
        />
      </Sheet>
    );
  }

  // Animated stops a running fade once the last view on its value goes away,
  // and closing the sheet moves the toast from the sheet's view to the app's.
  // On a phone the old view lets go (in a microtask) before the app's view
  // takes over (a later task), so the "Şikayet alındı" raised in the same tap
  // stayed at opacity 0. act() would flush both commits before that
  // microtask, so this runs on React's own scheduler, as the app does.
  it('finishes its fade in the view that draws it next', async () => {
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={SAFE_AREA}>
          <ToastProvider>
            <ReportFlow />
          </ToastProvider>
        </SafeAreaProvider>
      );
    });
    const tap = (label: string) =>
      tree!.root.find((node) => typeof node.type !== 'string' && node.props.accessibilityLabel === label).props.onPress();
    /** the toast's own opacity, read from its Animated.Value */
    const opacityOf = (title: string) =>
      tree!.root
        .findAll(
          (node) =>
            typeof node.type !== 'string' &&
            typeof StyleSheet.flatten(node.props.style)?.opacity === 'object' &&
            printed(node, title).length > 0
        )
        // the value's current number (an internal of Animated, not in its types)
        .map((node) => (StyleSheet.flatten(node.props.style).opacity as unknown as { __getValue(): number }).__getValue());
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      tap('Boş gönder');
      await wait(400);
      expect(opacityOf('Sebep yaz')).toEqual([1]);
      tap('Gönder');
      await wait(600);
      expect(opacityOf('Şikayet alındı')).toEqual([1]);
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });
});

describe('a sheet left open when its screen goes out of front', () => {
  /** Just enough of a screen's navigation object: focus and blur listeners. */
  function fakeNavigation() {
    const listeners = new Map<string, Set<() => void>>();
    const navigation = {
      isFocused: () => true,
      addListener: (type: string, callback: () => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(callback);
        listeners.set(type, set);
        return () => set.delete(callback);
      },
    };
    const emit = (type: string) => act(() => listeners.get(type)?.forEach((callback) => callback()));
    return { navigation, emit };
  }

  function Raise({ label, title }: { label: string; title: string }) {
    const toast = useToast();
    return <Pressable accessibilityLabel={label} onPress={() => toast({ title, kind: 'success' })} />;
  }

  function PokeScreen() {
    const [open, setOpen] = useState(true);
    return (
      <Sheet visible={open} onClose={() => setOpen(false)} title="Ali'ye ne diyelim?">
        <Raise label="Dürt" title="Dürttün" />
      </Sheet>
    );
  }

  let tree: ReactTestRenderer | null = null;
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
  });

  // A toast's onPress (or a notification) pushes the next screen with the
  // sheet still open: Android takes the dialog down with the screen, and a
  // sheet still holding the toast layer drew every later toast into it.
  it('closes, and the next screen\'s toasts show again', () => {
    const { navigation, emit } = fakeNavigation();
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 24, left: 0, right: 0, bottom: 48 } }}>
          <ToastProvider>
            <NavigationContext.Provider value={navigation as never}>
              <PokeScreen />
            </NavigationContext.Provider>
            <Raise label="Sonuç ekranında" title="Rövanş açıldı" />
          </ToastProvider>
        </SafeAreaProvider>
      );
    });
    expect(tree!.root.findByType(Modal).props.visible).toBe(true);

    emit('blur');
    expect(tree!.root.findByType(Modal).props.visible).toBe(false);
    act(() => {
      tree!.root.find((node) => typeof node.type !== 'string' && node.props.accessibilityLabel === 'Sonuç ekranında').props.onPress();
    });
    const printed = (root: ReactTestInstance) =>
      root.findAll((node) => typeof node.type === 'string' && node.props.children === 'Rövanş açıldı');
    expect(printed(tree!.root)).toHaveLength(1);
    expect(printed(tree!.root.findByType(Modal))).toHaveLength(0);
  });
});

describe('the offline strip', () => {
  const SAFE_AREA = {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 40, left: 0, right: 0, bottom: 20 },
  };

  afterEach(() => {
    Object.assign(mockConnection, { online: true, checked: true, longOffline: false });
  });

  /** what a screen under the strip would read, and how often it mounted */
  const seen: { insets?: EdgeInsets; mounts: number } = { mounts: 0 };

  function Probe() {
    seen.insets = useSafeAreaInsets();
    useEffect(() => {
      seen.mounts += 1;
    }, []);
    return null;
  }

  function render(): ReactTestRenderer {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <SafeAreaProvider initialMetrics={SAFE_AREA}>
          <OfflineFrame>
            <Probe />
          </OfflineFrame>
        </SafeAreaProvider>
      );
    });
    return tree;
  }

  const stripOf = (tree: ReactTestRenderer) =>
    tree.root.findAll((node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button');

  beforeEach(() => {
    seen.insets = undefined;
    seen.mounts = 0;
  });

  // Android is edge-to-edge: a strip at y = 0 sat behind the clock and the
  // cutout, and every screen below left the status bar's room once more
  it('pads itself below the status bar and gives the screens that room back', () => {
    mockConnection.online = false;
    const tree = render();
    const [strip] = stripOf(tree);
    expect(StyleSheet.flatten(strip!.props.style).paddingTop).toBe(46);
    expect(seen.insets).toMatchObject({ top: 0, bottom: 20 });
    act(() => tree.unmount());
  });

  it('leaves the screens alone while the server answers', () => {
    const tree = render();
    expect(stripOf(tree)).toHaveLength(0);
    expect(seen.insets).toMatchObject({ top: 40, bottom: 20 });
    act(() => tree.unmount());
  });

  it('does not remount the screens when it comes and goes', () => {
    const tree = render();
    mockConnection.online = false;
    act(() =>
      tree.update(
        <SafeAreaProvider initialMetrics={SAFE_AREA}>
          <OfflineFrame>
            <Probe />
          </OfflineFrame>
        </SafeAreaProvider>
      )
    );
    expect(stripOf(tree)).toHaveLength(1);
    expect(seen.insets?.top).toBe(0);
    // a remount here would have thrown away the navigation stack
    expect(seen.mounts).toBe(1);
    act(() => tree.unmount());
  });

  // A KeyboardAvoidingView measures its frame against its parent, not the
  // window, and the strip pushes every screen down by its own height: left out
  // of the offset, a form typed offline (an entry in the basement gym, the
  // server address) stopped that far short of the keyboard
  it('tells a keyboard form how far down the strip pushed it', () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const form = () => (
      <SafeAreaProvider initialMetrics={SAFE_AREA}>
        <OfflineFrame>
          <Screen keyboard>
            <Text>Adım</Text>
          </Screen>
        </OfflineFrame>
      </SafeAreaProvider>
    );
    const offsetOf = (tree: ReactTestRenderer) => tree.root.findByType(KeyboardAvoidingView).props.keyboardVerticalOffset;
    try {
      mockConnection.online = false;
      let tree!: ReactTestRenderer;
      act(() => {
        tree = create(form());
      });
      const [strip] = stripOf(tree);
      act(() => strip!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 62 } } }));
      expect(offsetOf(tree)).toBe(62);

      mockConnection.online = true;
      act(() => tree.update(form()));
      expect(offsetOf(tree)).toBe(0);
      act(() => tree.unmount());
    } finally {
      os.restore();
    }
  });
});
