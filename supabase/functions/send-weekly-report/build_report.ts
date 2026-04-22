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
}

export interface AppOpen {
  id: number;
  at: string;
  time_window: string;
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
  };
  scenes: SceneReport[];
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
  from: Date;
  to: Date;
}): Report {
  const { profile, sessions, placements, appOpens, from, to } = args;
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
    },
    scenes,
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
