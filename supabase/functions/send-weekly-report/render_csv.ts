import { AppOpen, Placement, Session } from "./build_report.ts";

export interface CsvBundle {
  sessions: string;
  placements: string;
  appOpens: string;
}

/**
 * Serialize raw rows to three CSVs. Kept separate from build_report
 * because therapists often want the unaggregated rows in Excel for
 * their own slicing.
 */
export function renderCsvs(args: {
  sessions: Session[];
  placements: Placement[];
  appOpens: AppOpen[];
}): CsvBundle {
  return {
    sessions: sessionsCsv(args.sessions),
    placements: placementsCsv(args.placements),
    appOpens: appOpensCsv(args.appOpens),
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
    ].join(",")
  );

  return [header, ...body].join("\n");
}

function appOpensCsv(rows: AppOpen[]): string {
  const header = ["at", "time_window"].join(",");
  const body = rows.map((r) => [esc(r.at), esc(r.time_window)].join(","));
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
