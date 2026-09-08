import { useEffect, useRef, useState } from 'react';

import { Text, type TextProps } from '@/components/Text';
import { Colors } from '@/theme';

export interface CountdownProps extends Omit<TextProps, 'children'> {
  /** ISO timestamp to count down to */
  target: string;
  prefix?: string;
  /** shown once the target is in the past */
  finishedLabel?: string;
  /** warn (turn red) when less than this many minutes remain */
  warnMinutes?: number;
  /** called once when the countdown reaches zero */
  onFinish?: () => void;
}

/** "2g 4sa" style Turkish countdown; ticks every second in the final hour. */
export function Countdown({
  target,
  prefix,
  finishedLabel = 'Bitti',
  warnMinutes = 60,
  onFinish,
  style,
  color,
  ...rest
}: CountdownProps) {
  const endMs = new Date(target).getTime();
  const [now, setNow] = useState(() => Date.now());
  const finishedRef = useRef(false);

  useEffect(() => {
    finishedRef.current = false;
  }, [target]);

  useEffect(() => {
    if (!Number.isFinite(endMs)) return;
    let timeout: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = endMs - Date.now();
      if (remaining <= 0) {
        setNow(Date.now());
        if (!finishedRef.current) {
          finishedRef.current = true;
          onFinish?.();
        }
        return;
      }
      // one second resolution in the last hour, otherwise half a minute
      const step = remaining < 3_600_000 ? 1000 : 30_000;
      timeout = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, Math.min(step, remaining));
    };
    schedule();
    return () => clearTimeout(timeout);
    // onFinish is intentionally not a dependency: it is a fire-once callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endMs]);

  if (!Number.isFinite(endMs)) return null;
  const diff = endMs - now;
  if (diff <= 0) {
    return (
      <Text {...rest} color={color} style={style}>
        {finishedLabel}
      </Text>
    );
  }

  const warn = diff < warnMinutes * 60_000;
  return (
    <Text {...rest} color={warn ? Colors.danger : color} style={style}>
      {prefix ? `${prefix} ` : ''}
      {formatRemaining(diff)}
    </Text>
  );
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}g ${hours}sa`;
  if (hours > 0) return `${hours}sa ${minutes}dk`;
  if (minutes > 0) return `${minutes}dk ${seconds}sn`;
  return `${seconds}sn`;
}
