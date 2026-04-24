import {
  AppOpen,
  BonusPlay,
  MissedSlot,
  Placement,
  Session,
} from "./build_report.ts";

export interface CsvBundle {
  sessions: string;
  placements: string;
  appOpens: string;
  // v2
  bonusPlays: string;
  missedSlots: string;
}

/**
 * Serialize raw rows to CSVs. Kept separate from build_report because
 * therapists often want the unaggregated rows in Excel for their own
 * slicing.
 */
export function renderCsvs(args: {
  sessions: Session[];
  placements: Placement[];
  appOpens: AppOpen[];
  bonusPlays?: BonusPlay[];
  missedSlots?: MissedSlot[];
}): CsvBundle {
  return {
    sessions: sessionsCsv(args.sessions),
    placements: placementsCsv(args.placements),
    appOpens: appOpensCsv(args.appOpens),
    bonusPlays: bonusPlaysCsv(args.bonusPlays ?? []),
    missedSlots: missedSlotsCsv(args.missedSlots ?? []),
  };
}

function sessionsCsv(rows: Session[]): string {
  const header = [
    "session_id",
    "scene_id",
    "started_at",
    "finished_at",
    "duration_s",
    "error_count",
    "completed",
    "sr_interval_start",
    "sr_interval_end",
    "difficulty_start",
    "difficulty_end",
    "orientation_correct",
    "orientation_response_ms",
    "instruction_replay_count",
    // v2
    "game1_error_count",
    "game1_completed",
    "game2_error_count",
    "game2_completed",
    "game2_type",
    "item_combo_hash",
  ].join(",");

  const body = rows.map((r) => {
    const durS = r.finished_at
      ? Math.round(
        (new Date(r.finished_at).getTime() -
          new Date(r.started_at).getTime()) / 1000,
      )
      : "";
    return [
      esc(r.id),
      esc(r.scene_id),
      esc(r.started_at),
      esc(r.finished_at ?? ""),
      durS,
      r.error_count,
      r.completed,
      r.sr_interval_start,
      r.sr_interval_end,
      r.difficulty_start,
      r.difficulty_end,
      r.orientation_correct === null ? "" : r.orientation_correct,
      r.orientation_response_ms ?? "",
      r.instruction_replay_count,
      r.game1_error_count ?? "",
      r.game1_completed ?? "",
      r.game2_error_count ?? "",
      r.game2_completed ?? "",
      esc(r.game2_type ?? ""),
      esc(r.item_combo_hash ?? ""),
    ].join(",");
  });

  return [header, ...body].join("\n");
}

function placementsCsv(rows: Placement[]): string {
  const header = [
    "session_id",
    "item_id",
    "correct",
    "tapped_distractor",
    "reaction_ms",
    "wait_ms",
    "at",
    "item_count_at_scene",
    "distractor_category",
    "sequence_required",
    "difficulty_level",
    // v2
    "game_type",
  ].join(",");

  const body = rows.map((r) =>
    [
      esc(r.session_id),
      esc(r.item_id),
      r.correct,
      r.tapped_distractor,
      r.reaction_ms,
      r.wait_ms,
      esc(r.at),
      r.item_count_at_scene,
      esc(r.distractor_category),
      r.sequence_required,
      r.difficulty_level,
      esc(r.game_type ?? "game1"),
    ].join(",")
  );

  return [header, ...body].join("\n");
}

function appOpensCsv(rows: AppOpen[]): string {
  const header = ["at", "time_window"].join(",");
  const body = rows.map((r) => [esc(r.at), esc(r.time_window)].join(","));
  return [header, ...body].join("\n");
}

function bonusPlaysCsv(rows: BonusPlay[]): string {
  const header = [
    "bonus_play_id",
    "bonus_scene_id",
    "bonus_type",
    "started_at",
    "finished_at",
    "tap_count",
    "night_bonus",
    "time_window",
  ].join(",");
  const body = rows.map((r) =>
    [
      esc(r.id),
      esc(r.bonus_scene_id),
      esc(r.bonus_type),
      esc(r.started_at),
      esc(r.finished_at ?? ""),
      r.tap_count,
      r.night_bonus,
      esc(r.time_window),
    ].join(",")
  );
  return [header, ...body].join("\n");
}

function missedSlotsCsv(rows: MissedSlot[]): string {
  const header = [
    "time_window",
    "scene_id",
    "missed_on",
    "detected_at",
  ].join(",");
  const body = rows.map((r) =>
    [
      esc(r.time_window),
      esc(r.scene_id),
      esc(r.missed_on),
      esc(r.detected_at),
    ].join(",")
  );
  return [header, ...body].join("\n");
}

/**
 * Escape a CSV cell. Wraps in quotes if it contains comma, quote, or
 * newline; doubles any embedded quotes per RFC 4180.
 */
function esc(v: string): string {
  if (!/[",\n\r]/.test(v)) return v;
  return `"${v.replaceAll('"', '""')}"`;
}
