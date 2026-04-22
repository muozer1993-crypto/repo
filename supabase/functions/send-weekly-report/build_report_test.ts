import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  AppOpen,
  buildReport,
  Placement,
  Profile,
  Session,
} from "./build_report.ts";

const profile: Profile = {
  id: "uuid-1",
  name: "Ayşe",
  age_band: "from65to74",
  therapist_email: "t@c.tr",
  created_at: "2026-04-01T00:00:00Z",
};

function session(
  id: string,
  sceneId: string,
  startIso: string,
  endIso: string,
  errorCount: number,
  completed: boolean,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    profile_id: profile.id,
    scene_id: sceneId,
    started_at: startIso,
    finished_at: endIso,
    error_count: errorCount,
    completed,
    sr_interval_start: 1,
    sr_interval_end: 2,
    difficulty_start: 1,
    difficulty_end: 1,
    orientation_correct: true,
    orientation_response_ms: 3000,
    instruction_replay_count: 0,
    ...overrides,
  };
}

function placement(
  sessionId: string,
  correct: boolean,
  category: Placement["distractor_category"],
  overrides: Partial<Placement> = {},
): Placement {
  return {
    id: 0,
    session_id: sessionId,
    item_id: "x",
    correct,
    tapped_distractor: !correct,
    reaction_ms: 2000,
    wait_ms: 1500,
    at: "2026-04-18T09:00:00Z",
    item_count_at_scene: 6,
    distractor_category: category,
    sequence_required: false,
    difficulty_level: 1,
    ...overrides,
  };
}

Deno.test("summary: completion rate and total minutes", () => {
  const sessions = [
    session("s1", "sabah", "2026-04-18T09:00:00Z", "2026-04-18T09:02:00Z", 0, true),
    session("s2", "sabah", "2026-04-19T09:00:00Z", "2026-04-19T09:03:00Z", 3, false),
  ];
  const r = buildReport({
    profile,
    sessions,
    placements: [],
    appOpens: [],
    from: new Date("2026-04-15T00:00:00Z"),
    to: new Date("2026-04-22T00:00:00Z"),
  });

  assertEquals(r.summary.sessionCount, 2);
  assertEquals(r.summary.completedCount, 1);
  assertAlmostEquals(r.summary.completionRate, 0.5);
  assertEquals(r.summary.totalPlayMinutes, 5);
});

Deno.test("summary: orientation rate and avg response time", () => {
  const sessions = [
    session("s1", "sabah", "2026-04-18T09:00:00Z", "2026-04-18T09:01:00Z", 0, true),
    session("s2", "sabah", "2026-04-19T09:00:00Z", "2026-04-19T09:01:00Z", 1, true, {
      orientation_correct: false,
      orientation_response_ms: 5000,
    }),
    session("s3", "sabah", "2026-04-20T09:00:00Z", "2026-04-20T09:01:00Z", 0, true, {
      orientation_correct: true,
      orientation_response_ms: 1000,
    }),
  ];
  const r = buildReport({
    profile,
    sessions,
    placements: [],
    appOpens: [],
    from: new Date("2026-04-15T00:00:00Z"),
    to: new Date("2026-04-22T00:00:00Z"),
  });

  // 2 correct out of 3 attempts.
  assertAlmostEquals(r.summary.orientationCorrectRate!, 2 / 3);
  // Avg of correct answers only: (3000 + 1000) / 2.
  assertAlmostEquals(r.summary.orientationAvgResponseMs!, 2000);
});

Deno.test("per-scene: error rate by distractor category", () => {
  const sessions = [
    session("s1", "sabah", "2026-04-18T09:00:00Z", "2026-04-18T09:02:00Z", 2, true),
  ];
  const placements: Placement[] = [
    placement("s1", false, "far"),
    placement("s1", true, "far"),
    placement("s1", false, "near"),
    placement("s1", false, "near"),
    placement("s1", true, "near"),
    placement("s1", true, "absent"),
  ];

  const r = buildReport({
    profile,
    sessions,
    placements,
    appOpens: [],
    from: new Date("2026-04-15T00:00:00Z"),
    to: new Date("2026-04-22T00:00:00Z"),
  });

  const scene = r.scenes.find((s) => s.sceneId === "sabah")!;
  // far: 1 wrong / 2 = 0.5
  assertAlmostEquals(scene.distractorErrorRates.far, 0.5);
  // near: 2 wrong / 3 = 0.67
  assertAlmostEquals(scene.distractorErrorRates.near, 2 / 3);
  // absent: 0 wrong / 1 = 0
  assertEquals(scene.distractorErrorRates.absent, 0);
});

Deno.test("per-scene: sequenceRequired vs sequenceFree error rates", () => {
  const sessions = [
    session("s1", "sabah", "2026-04-18T09:00:00Z", "2026-04-18T09:02:00Z", 2, true),
  ];
  const placements: Placement[] = [
    placement("s1", true, "absent", { sequence_required: false }),
    placement("s1", false, "absent", { sequence_required: false }),
    placement("s1", false, "absent", { sequence_required: true }),
  ];
  const r = buildReport({
    profile,
    sessions,
    placements,
    appOpens: [],
    from: new Date("2026-04-15T00:00:00Z"),
    to: new Date("2026-04-22T00:00:00Z"),
  });
  const scene = r.scenes[0];
  assertEquals(scene.sequenceFreeErrorRate, 0.5);
  assertEquals(scene.sequenceRequiredErrorRate, 1.0);
});

Deno.test("summary: app-opens time window distribution", () => {
  const opens: AppOpen[] = [
    { id: 1, at: "2026-04-18T08:00:00Z", time_window: "sabah" },
    { id: 2, at: "2026-04-18T12:00:00Z", time_window: "oglen" },
    { id: 3, at: "2026-04-19T08:00:00Z", time_window: "sabah" },
  ];
  const r = buildReport({
    profile,
    sessions: [],
    placements: [],
    appOpens: opens,
    from: new Date("2026-04-15T00:00:00Z"),
    to: new Date("2026-04-22T00:00:00Z"),
  });
  assertEquals(r.summary.windowDistribution.sabah, 2);
  assertEquals(r.summary.windowDistribution.oglen, 1);
  assertEquals(r.summary.windowDistribution.ikindi, 0);
  assertEquals(r.summary.appOpensCount, 3);
});
