import { StyleSheet } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Chip } from '@/components/Chip';
import { formatRemaining } from '@/components/Countdown';
import { ProgressBar } from '@/components/ProgressBar';
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
    expect(textIn(tree!.toJSON()).join(' ')).toContain('Sonuç geldi!');
  });
});

describe('Chip', () => {
  it('shows the label and icon', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(<Chip label="ÖNDESİN" icon="🔥" filled color="#2EE59D" />);
    });
    const strings = textIn(tree!.toJSON()).join(' ');
    expect(strings).toContain('ÖNDESİN');
    expect(strings).toContain('🔥');
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
