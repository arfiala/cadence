// Golf rounds API (ISC-428/429): one merged view over two spines.
// golf_scorecards (synced from Garmin Golf) join same-New-York-day golf
// activities (watch recordings). A user-entered activities.golf_score always
// wins over a synced strokes value for display (ISC-429): an explicit edit is
// stronger provenance than a sync, the same principle that protects notes.
// The sync never writes golf_score (ISC-430).

import { db } from "../db";
import type { ActivityRow } from "../db";
import { nyDateString } from "../week";
import { serializeActivity } from "./activities";

export type GolfScorecardRow = {
  id: number;
  scorecard_id: string;
  course_name: string | null;
  start_time: string | null;
  round_date: string | null;
  strokes: number | null;
  holes_played: number | null;
  round_type: string | null;
};

export function listGolfRounds() {
  const cards = db
    .query("SELECT * FROM golf_scorecards ORDER BY start_time DESC")
    .all() as GolfScorecardRow[];
  const acts = db
    .query("SELECT * FROM activities WHERE sport = 'golf' ORDER BY start_time DESC")
    .all() as ActivityRow[];

  const actByDate = new Map<string, ActivityRow[]>();
  for (const a of acts) {
    const d = nyDateString(new Date(a.start_time));
    const bucket = actByDate.get(d) ?? [];
    bucket.push(a);
    actByDate.set(d, bucket);
  }

  const usedActivityIds = new Set<number>();
  const rounds = cards.map((c) => {
    let activity: ActivityRow | null = null;
    if (c.round_date) {
      const bucket = actByDate.get(c.round_date) ?? [];
      activity = bucket.find((a) => !usedActivityIds.has(a.id)) ?? null;
      if (activity) usedActivityIds.add(activity.id);
    }
    const userScore = activity?.golf_score ?? null;
    return {
      kind: "scorecard" as const,
      scorecard_id: c.scorecard_id,
      course_name: c.course_name,
      date: c.round_date ?? (c.start_time ? nyDateString(new Date(c.start_time)) : null),
      start_time: c.start_time ?? activity?.start_time ?? null,
      holes_played: c.holes_played,
      round_type: c.round_type,
      synced_strokes: c.strokes,
      // ISC-429: explicit user entry outranks the synced value.
      display_score: userScore ?? c.strokes,
      score_source: userScore !== null ? "manual" : c.strokes !== null ? "garmin" : null,
      activity: activity ? serializeActivity(activity) : null,
    };
  });

  const activityOnly = acts
    .filter((a) => !usedActivityIds.has(a.id))
    .map((a) => ({
      kind: "activity" as const,
      scorecard_id: null,
      course_name: a.title,
      date: nyDateString(new Date(a.start_time)),
      start_time: a.start_time,
      holes_played: null,
      round_type: null,
      synced_strokes: null,
      display_score: a.golf_score,
      score_source: a.golf_score !== null ? ("manual" as const) : null,
      activity: serializeActivity(a),
    }));

  return [...rounds, ...activityOnly].sort((x, y) =>
    String(y.start_time ?? "").localeCompare(String(x.start_time ?? "")),
  );
}

export function handleGolfRounds(): Response {
  return Response.json({ rounds: listGolfRounds() });
}
