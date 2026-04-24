// deno-lint-ignore-file no-explicit-any

export interface Profile {
  id: string;
  name: string;
  age_band: string;
  therapist_email: string;
  created_at: string;
}

export interface Session {
  id: string;
  profile_id: string;
  scene_id: string;
  started_at: string;
  finished_at: string | null;
  error_count: number;
  completed: boolean;
  sr_interval_start: number;
  sr_interval_end: number;
  difficulty_start: number;
  difficulty_end: number;
  orientation_correct: boolean | null;
  orientation_response_ms: number | null;
  instruction_replay_count: number;
  // v2
  game1_error_count?: number;
  game1_completed?: boolean;
  game2_error_count?: number;
  game2_completed?: boolean;
  game2_type?:
    | "plate_matching"
    | "sequence_ordering"
    | "quantity_counting"
    | "next_step_planning"
    | null;
  item_combo_hash?: string | null;
}

export interface Placement {
  id: number;
  session_id: string;
  item_id: string;
  correct: boolean;
  tapped_distractor: boolean;
  reaction_ms: number;
  wait_ms: number;
  at: string;
  item_count_at_scene: number;
  distractor_category: "absent" | "far" | "near" | "functional";
  sequence_required: boolean;
  difficulty_level: number;
  // v2
  game_type?: "game1" | "game2" | "bonus";
}

export interface AppOpen {
  id: number;
  at: string;
  time_window: string;
}

// v2 — new tables
export interface BonusPlay {
  id: string;
  profile_id: string;
  bonus_scene_id: string;
  bonus_type:
    | "find_item"
    | "tap_sequence"
    | "pair_match"
    | "free_explore";
  started_at: string;
  finished_at: string | null;
  tap_count: number;
  night_bonus: boolean;
  time_window: string;
}

export interface MissedSlot {
  id: number;
  profile_id: string;
  time_window: "sabah" | "oglen" | "ikindi" | "aksam";
  scene_id: string;
  missed_on: string; // ISO date (YYYY-MM-DD)
  detected_at: string;
}

export interface Report {
  range: { from: string; to: string };
  profile: Profile;
  summary: {
    sessionCount: number;
    completedCount: number;
    completionRate: number;
    totalPlayMinutes: number;
    appOpensCount: number;
    avgDailyOpens: number;
    windowDistribution: Record<string, number>;
    orientationCorrectRate: number | null;
    orientationAvgResponseMs: number | null;
    avgInstructionReplays: number;
    // v2
    game1CompletionRate: number | null;
    game2CompletionRate: number | null;
    bonusEngagementRate: number | null;
    bonusPlayCount: number;
    missedSlotCount: number;
  };
  scenes: SceneReport[];
  // v2 — aggregated once per report, not per scene.
  game2TypeBreakdown: Record<string, Game2TypeReport>;
  bonusBreakdown: Record<string, BonusTypeReport>;
  /**
   * Missed slot heatmap: day-of-week index (0=Mon..6=Sun) →
   * window → 1/0. Value is the count of missed events on that slot
   * across the week.
   */
  missedSlotHeatmap: Array<{
    dayIndex: number; // 0..6 (Mon..Sun)
    window: string;
    count: number;
  }>;
}

export interface Game2TypeReport {
  type: string;
  playCount: number;
  completionRate: number;
  avgErrorCount: number;
}

export interface BonusTypeReport {
  type: string;
  playCount: number;
  avgTapCount: number;
  nightCount: number;
}

export interface SceneReport {
  sceneId: string;
  srInterval: number;
  difficultyLevel: number;
  playCount: number;
  completionRate: number;
  avgReactionMs: number;
  avgWaitMs: number;
  avgErrorCount: number;
  distractorErrorRates: Record<string, number>;
  sequenceRequiredErrorRate: number | null;
  sequenceFreeErrorRate: number | null;
  lastFive: Session[];
}

/**
 * Pure aggregation: given a week of session/placement/app_open data,
 * produce the Report object the PDF/CSV renderers consume.
 *
 * No I/O here — trivially testable with fixture arrays.
 */
export function buildReport(args: {
  profile: Profile;
  sessions: Session[];
  placements: Placement[];
  appOpens: AppOpen[];
  bonusPlays?: BonusPlay[];
  missedSlots?: MissedSlot[];
  from: Date;
  to: Date;
}): Report {
  const {
    profile,
    sessions,
    placements,
    appOpens,
    from,
    to,
  } = args;
  const bonusPlays = args.bonusPlays ?? [];
  const missedSlots = args.missedSlots ?? [];
  const days = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / 86_400_000),
  );

  const completed = sessions.filter((s) => s.completed);
  const totalPlayMs = sessions.reduce((acc, s) => {
    if (!s.finished_at) return acc;
    return acc +
      (new Date(s.finished_at).getTime() - new Date(s.started_at).getTime());
  }, 0);

  const windowDist: Record<string, number> = {
    sabah: 0,
    oglen: 0,
    ikindi: 0,
    aksam: 0,
    dinlenme: 0,
  };
  for (const o of appOpens) {
    windowDist[o.time_window] = (windowDist[o.time_window] ?? 0) + 1;
  }

  const orientationAttempts = sessions.filter(
    (s) => s.orientation_correct !== null,
  );
  const orientationCorrect = orientationAttempts.filter(
    (s) => s.orientation_correct === true,
  );

  const scenes = groupBy(sessions, (s) => s.scene_id).map(([sceneId, rows]) => {
    const rowsSorted = [...rows].sort((a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    );
    const latest = rowsSorted[0];
    const placementsForScene = placements.filter(
      (p) => rows.find((s) => s.id === p.session_id) !== undefined,
    );
    const seqReq = placementsForScene.filter((p) => p.sequence_required);
    const seqFree = placementsForScene.filter((p) => !p.sequence_required);
    return {
      sceneId,
      srInterval: latest.sr_interval_end,
      difficultyLevel: latest.difficulty_end,
      playCount: rows.length,
      completionRate: rows.length === 0
        ? 0
        : rows.filter((r) => r.completed).length / rows.length,
      avgReactionMs: avg(placementsForScene.map((p) => p.reaction_ms)),
      avgWaitMs: avg(placementsForScene.map((p) => p.wait_ms)),
      avgErrorCount: avg(rows.map((r) => r.error_count)),
      distractorErrorRates: errorRateByCategory(placementsForScene),
      sequenceRequiredErrorRate: seqReq.length === 0
        ? null
        : seqReq.filter((p) => !p.correct).length / seqReq.length,
      sequenceFreeErrorRate: seqFree.length === 0
        ? null
        : seqFree.filter((p) => !p.correct).length / seqFree.length,
      lastFive: rowsSorted.slice(0, 5),
    } as SceneReport;
  });

  // v2 — per-game completion rates. We count only sessions that
  // actually carried a Game-1/Game-2 attempt (i.e. the mirror column
  // exists). Sessions that predate migration 0002 leave them as 0.
  const g1Attempts = sessions.filter((s) =>
    typeof s.game1_error_count === "number"
  );
  const g2Attempts = sessions.filter((s) => s.game2_type != null);
  const g1Completed = g1Attempts.filter((s) => s.game1_completed === true);
  const g2Completed = g2Attempts.filter((s) => s.game2_completed === true);

  const game2TypeBreakdown: Record<string, Game2TypeReport> = {};
  for (const s of g2Attempts) {
    const t = s.game2_type as string;
    const cur = game2TypeBreakdown[t] ?? {
      type: t,
      playCount: 0,
      completionRate: 0,
      avgErrorCount: 0,
    };
    cur.playCount += 1;
    cur.completionRate += s.game2_completed === true ? 1 : 0;
    cur.avgErrorCount += s.game2_error_count ?? 0;
    game2TypeBreakdown[t] = cur;
  }
  for (const key of Object.keys(game2TypeBreakdown)) {
    const r = game2TypeBreakdown[key];
    if (r.playCount > 0) {
      r.completionRate = r.completionRate / r.playCount;
      r.avgErrorCount = r.avgErrorCount / r.playCount;
    }
  }

  // v2 — bonus breakdown.
  const bonusBreakdown: Record<string, BonusTypeReport> = {};
  for (const b of bonusPlays) {
    const cur = bonusBreakdown[b.bonus_type] ?? {
      type: b.bonus_type,
      playCount: 0,
      avgTapCount: 0,
      nightCount: 0,
    };
    cur.playCount += 1;
    cur.avgTapCount += b.tap_count;
    cur.nightCount += b.night_bonus ? 1 : 0;
    bonusBreakdown[b.bonus_type] = cur;
  }
  for (const key of Object.keys(bonusBreakdown)) {
    const r = bonusBreakdown[key];
    if (r.playCount > 0) {
      r.avgTapCount = r.avgTapCount / r.playCount;
    }
  }

  // Engagement = finished bonuses / total bonus offers. We approximate
  // offers with "sessions with a bonusable scene"; a cleaner value
  // would need a BonusOffer event, which is a v3 concern.
  const bonusEngaged = bonusPlays.filter((b) => b.finished_at != null);
  const bonusEngagementRate = bonusPlays.length === 0
    ? null
    : bonusEngaged.length / bonusPlays.length;

  // v2 — missed slot heatmap. Day-of-week per ISO weekday (1..7),
  // remapped to 0..6 Mon→Sun for easier grid rendering.
  const missedSlotHeatmap: Array<
    { dayIndex: number; window: string; count: number }
  > = [];
  for (const m of missedSlots) {
    const d = new Date(`${m.missed_on}T00:00:00Z`);
    const dayIndex = (d.getUTCDay() + 6) % 7; // ISO Mon=0..Sun=6
    const existing = missedSlotHeatmap.find(
      (h) => h.dayIndex === dayIndex && h.window === m.time_window,
    );
    if (existing) {
      existing.count += 1;
    } else {
      missedSlotHeatmap.push({
        dayIndex,
        window: m.time_window,
        count: 1,
      });
    }
  }

  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    profile,
    summary: {
      sessionCount: sessions.length,
      completedCount: completed.length,
      completionRate: sessions.length === 0
        ? 0
        : completed.length / sessions.length,
      totalPlayMinutes: Math.round(totalPlayMs / 60_000),
      appOpensCount: appOpens.length,
      avgDailyOpens: appOpens.length / days,
      windowDistribution: windowDist,
      orientationCorrectRate: orientationAttempts.length === 0
        ? null
        : orientationCorrect.length / orientationAttempts.length,
      orientationAvgResponseMs: orientationCorrect.length === 0
        ? null
        : avg(
          orientationCorrect.map((s) => s.orientation_response_ms ?? 0),
        ),
      avgInstructionReplays: avg(
        sessions.map((s) => s.instruction_replay_count),
      ),
      // v2
      game1CompletionRate: g1Attempts.length === 0
        ? null
        : g1Completed.length / g1Attempts.length,
      game2CompletionRate: g2Attempts.length === 0
        ? null
        : g2Completed.length / g2Attempts.length,
      bonusEngagementRate,
      bonusPlayCount: bonusPlays.length,
      missedSlotCount: missedSlots.length,
    },
    scenes,
    game2TypeBreakdown,
    bonusBreakdown,
    missedSlotHeatmap,
  };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function groupBy<T, K extends string>(
  xs: T[],
  key: (x: T) => K,
): Array<[K, T[]]> {
  const map = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = map.get(k) ?? [];
    arr.push(x);
    map.set(k, arr);
  }
  return [...map.entries()];
}

function errorRateByCategory(
  ps: Placement[],
): Record<string, number> {
  const result: Record<string, number> = {
    absent: 0,
    far: 0,
    near: 0,
    functional: 0,
  };
  for (const cat of Object.keys(result)) {
    const slice = ps.filter((p) => p.distractor_category === cat);
    result[cat] = slice.length === 0
      ? 0
      : slice.filter((p) => !p.correct).length / slice.length;
  }
  return result;
}
