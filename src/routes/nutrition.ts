// /api/nutrition: the calorie/macro counter (ISC-199..205). You describe a
// meal in plain language, the LLM estimates itemized calories and macros, the
// entry is saved as an editable itemized row, and the day view rolls it up
// against a target. Mirrors src/routes/activities.ts for shape (serializeX,
// validation helpers, listX/createX/updateX/deleteX, RETURNING *, jsonError/
// readJsonBody). This spine is entirely separate from `activities` and never
// feeds the G1 training metric (ISC-214).

import { db } from "../db";
import type { NutritionEntryRow, NutritionItemRow } from "../db";
import { jsonError, readJsonBody } from "../lib/http";
import { nyDateString } from "../week";
import { estimateNutrition } from "../services/nutritionEstimate";
import type { NutritionItem } from "../services/nutritionEstimate";

const DESCRIPTION_MAX = 2000;
const FOOD_MAX = 500;
const QUANTITY_MAX = 200;
const NOTES_MAX = 2000;
const MAX_KCAL = 20000;
const MAX_MACRO_G = 5000;
const DEFAULT_TARGET_KCAL = 2200;
const DEFAULT_TARGET_PROTEIN_G = 150;

type Totals = { kcal: number; protein_g: number; carbs_g: number; fat_g: number };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Entry kcal is an integer column; macros are 1-decimal reals. Totals are the
// sum of the entry's items, recomputed on every save/edit so the header can
// never drift from the rows (ISC-189).
function computeTotals(items: NutritionItem[]): Totals {
  let kcal = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  for (const item of items) {
    kcal += item.kcal;
    protein += item.protein_g;
    carbs += item.carbs_g;
    fat += item.fat_g;
  }
  return {
    kcal: Math.round(kcal),
    protein_g: round1(protein),
    carbs_g: round1(carbs),
    fat_g: round1(fat),
  };
}

function serializeItem(row: NutritionItemRow) {
  return {
    id: row.id,
    food: row.food,
    quantity: row.quantity,
    kcal: row.kcal,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
  };
}

function itemsForEntry(entryId: number): NutritionItemRow[] {
  return db
    .query("SELECT * FROM nutrition_items WHERE entry_id = ? ORDER BY id ASC")
    .all(entryId) as NutritionItemRow[];
}

function serializeEntry(row: NutritionEntryRow) {
  return {
    id: row.id,
    logged_date: row.logged_date,
    logged_at: row.logged_at,
    description: row.description,
    source: row.source,
    kcal: row.kcal,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: itemsForEntry(row.id).map(serializeItem),
  };
}

// YYYY-MM-DD that is also a real calendar date.
function isValidYmd(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms);
}

function nutritionTargets(): {
  target_kcal: number;
  target_protein_g: number;
  target_carbs_g: number | null;
  target_fat_g: number | null;
} {
  const rows = db
    .query(
      "SELECT key, value FROM settings WHERE key IN ('nutrition_target_kcal','nutrition_target_protein_g','nutrition_target_carbs_g','nutrition_target_fat_g')",
    )
    .all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const kcal = Number(map.get("nutrition_target_kcal") ?? String(DEFAULT_TARGET_KCAL));
  const protein = Number(map.get("nutrition_target_protein_g") ?? String(DEFAULT_TARGET_PROTEIN_G));
  const optional = (key: string): number | null => {
    const raw = map.get(key);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    target_kcal: Number.isFinite(kcal) ? kcal : DEFAULT_TARGET_KCAL,
    target_protein_g: Number.isFinite(protein) ? protein : DEFAULT_TARGET_PROTEIN_G,
    target_carbs_g: optional("nutrition_target_carbs_g"),
    target_fat_g: optional("nutrition_target_fat_g"),
  };
}

// Validate a client-supplied item array (manual entry or an edited estimate).
// Numbers are coerced to storage precision: kcal to an integer, macros to one
// decimal. Any invalid field rejects the whole request (400).
function validateItems(
  raw: unknown,
): { ok: true; value: NutritionItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "items must be a non-empty array" };
  }
  const out: NutritionItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: "each item must be an object" };
    }
    const r = entry as Record<string, unknown>;
    if (typeof r.food !== "string" || r.food.trim().length === 0) {
      return { ok: false, error: "each item needs a non-empty food name" };
    }
    if (r.food.length > FOOD_MAX) {
      return { ok: false, error: `food name must be at most ${FOOD_MAX} characters` };
    }
    let quantity: string | null = null;
    if (r.quantity !== undefined && r.quantity !== null) {
      if (typeof r.quantity !== "string") {
        return { ok: false, error: "quantity must be a string" };
      }
      if (r.quantity.length > QUANTITY_MAX) {
        return { ok: false, error: `quantity must be at most ${QUANTITY_MAX} characters` };
      }
      quantity = r.quantity.trim().length > 0 ? r.quantity : null;
    }
    const nums: Record<"kcal" | "protein_g" | "carbs_g" | "fat_g", number> = {
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
    };
    for (const key of ["kcal", "protein_g", "carbs_g", "fat_g"] as const) {
      const v = r[key];
      const max = key === "kcal" ? MAX_KCAL : MAX_MACRO_G;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
        return { ok: false, error: `${key} must be a non-negative number within range` };
      }
      nums[key] = v;
    }
    out.push({
      food: r.food.trim(),
      quantity,
      kcal: Math.round(nums.kcal),
      protein_g: round1(nums.protein_g),
      carbs_g: round1(nums.carbs_g),
      fat_g: round1(nums.fat_g),
    });
  }
  return { ok: true, value: out };
}

// Insert an entry + its items in a single transaction, computing header totals
// from the items. Returns the created entry id.
const insertEntryTx = db.transaction(
  (
    loggedDate: string,
    loggedAt: string,
    description: string | null,
    source: "estimated" | "manual" | "edited",
    notes: string | null,
    items: NutritionItem[],
  ): number => {
    const totals = computeTotals(items);
    const entry = db
      .query(
        `INSERT INTO nutrition_entries
           (logged_date, logged_at, description, source, kcal, protein_g, carbs_g, fat_g, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        loggedDate,
        loggedAt,
        description,
        source,
        totals.kcal,
        totals.protein_g,
        totals.carbs_g,
        totals.fat_g,
        notes,
      ) as { id: number };
    const insertItem = db.query(
      `INSERT INTO nutrition_items (entry_id, food, quantity, kcal, protein_g, carbs_g, fat_g)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insertItem.run(
        entry.id,
        item.food,
        item.quantity,
        item.kcal,
        item.protein_g,
        item.carbs_g,
        item.fat_g,
      );
    }
    return entry.id;
  },
);

// POST /api/nutrition/estimate (ISC-199) — free text in, itemized estimate
// out, NOT persisted. When estimation is unavailable (no key, LLM error, bad
// response) this still returns 200 with an "unavailable" flag + reason so the
// UI falls back to manual entry rather than seeing an error. DB unchanged.
export async function estimateNutritionRoute(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  const description = body.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return jsonError("description is required", 400);
  }
  if (description.length > DESCRIPTION_MAX) {
    return jsonError(`description must be at most ${DESCRIPTION_MAX} characters`, 400);
  }

  const result = await estimateNutrition(description);
  if (!result.ok) {
    return Response.json({ items: [], totals: computeTotals([]), unavailable: true, reason: result.reason });
  }
  return Response.json({ items: result.items, totals: computeTotals(result.items) });
}

// POST /api/nutrition (ISC-200) — save an entry. Two shapes:
//   { description, estimate: true }  -> server estimates then saves ('estimated')
//   { description?, items: [...], source?: "manual" } -> explicit ('manual')
// If estimate:true and estimation is unavailable, returns 422 with the reason
// so the client switches to manual. Insert is one transaction.
export async function createNutrition(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  // Shared optional fields.
  const description = body.description;
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") return jsonError("description must be a string", 400);
    if (description.length > DESCRIPTION_MAX) {
      return jsonError(`description must be at most ${DESCRIPTION_MAX} characters`, 400);
    }
  }
  const notes = body.notes;
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== "string") return jsonError("notes must be a string", 400);
    if (notes.length > NOTES_MAX) {
      return jsonError(`notes must be at most ${NOTES_MAX} characters`, 400);
    }
  }
  let loggedDate = nyDateString(new Date());
  if ("logged_date" in body && body.logged_date !== undefined && body.logged_date !== null) {
    if (!isValidYmd(body.logged_date)) return jsonError("logged_date must be YYYY-MM-DD", 400);
    loggedDate = body.logged_date;
  }

  let items: NutritionItem[];
  let source: "estimated" | "manual";

  if (body.quick === true) {
    // Quick calorie log (ISC-457): a bare number, no itemizing. Stored as a
    // one-item manual entry so it flows through the exact same day totals,
    // edit, and delete paths as any other entry (ISC-458). Never fabricates:
    // carbs/fat are 0 because the user did not supply them, not guessed.
    const kcal = body.kcal;
    if (typeof kcal !== "number" || !Number.isInteger(kcal) || kcal <= 0) {
      return jsonError("kcal must be a positive integer", 400);
    }
    let protein = 0;
    if (body.protein_g !== undefined && body.protein_g !== null) {
      const p = body.protein_g;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) {
        return jsonError("protein_g must be a non-negative number", 400);
      }
      protein = Math.round(p * 10) / 10;
    }
    items = [
      { food: "Quick calories", quantity: null, kcal, protein_g: protein, carbs_g: 0, fat_g: 0 },
    ];
    source = "manual";
  } else if (body.estimate === true) {
    if (typeof description !== "string" || description.trim().length === 0) {
      return jsonError("description is required when estimate is true", 400);
    }
    const result = await estimateNutrition(description);
    if (!result.ok) {
      // Client falls back to manual entry (ISC-196). Never fabricate.
      return Response.json(
        {
          error: "Auto-estimate is unavailable. Add the entry manually with explicit macros.",
          reason: result.reason,
        },
        { status: 422 },
      );
    }
    items = result.items;
    source = "estimated";
  } else {
    const validated = validateItems(body.items);
    if (!validated.ok) return jsonError(validated.error, 400);
    items = validated.value;
    source = "manual";
  }

  const loggedAt = new Date().toISOString();
  const id = insertEntryTx(
    loggedDate,
    loggedAt,
    (description as string | null | undefined) ?? null,
    source,
    (notes as string | null | undefined) ?? null,
    items,
  );

  const row = db.query("SELECT * FROM nutrition_entries WHERE id = ?").get(id) as NutritionEntryRow;
  return Response.json({ entry: serializeEntry(row) }, { status: 201 });
}

// GET /api/nutrition?date=YYYY-MM-DD (ISC-201) — that day's entries (newest
// first) plus day totals vs the target. Default date is today (NY calendar).
export function listNutrition(url: URL): Response {
  const dateParam = url.searchParams.get("date");
  let date = nyDateString(new Date());
  if (dateParam !== null) {
    if (!isValidYmd(dateParam)) return jsonError("Invalid 'date' (expected YYYY-MM-DD)", 400);
    date = dateParam;
  }

  const rows = db
    .query("SELECT * FROM nutrition_entries WHERE logged_date = ? ORDER BY logged_at DESC, id DESC")
    .all(date) as NutritionEntryRow[];

  const totals: Totals = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const row of rows) {
    totals.kcal += row.kcal;
    totals.protein_g += row.protein_g;
    totals.carbs_g += row.carbs_g;
    totals.fat_g += row.fat_g;
  }
  totals.protein_g = round1(totals.protein_g);
  totals.carbs_g = round1(totals.carbs_g);
  totals.fat_g = round1(totals.fat_g);

  const targets = nutritionTargets();
  return Response.json({
    date,
    entries: rows.map(serializeEntry),
    totals,
    target_kcal: targets.target_kcal,
    target_protein_g: targets.target_protein_g,
    target_carbs_g: targets.target_carbs_g,
    target_fat_g: targets.target_fat_g,
  });
}

// GET /api/nutrition/history?days=N (ISC-462): per-day kcal and protein
// totals over the last N New York calendar days, including zero days so the
// chart has a continuous axis. Targets ride along for the goal lines.
export function nutritionHistory(url: URL): Response {
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam)
    ? Math.min(365, Math.max(1, Math.trunc(daysParam)))
    : 30;

  // One aggregate query keyed on logged_date, then fill the gaps in JS so a
  // day with no entries still appears at zero.
  const rows = db
    .query(
      `SELECT logged_date, SUM(kcal) AS kcal, SUM(protein_g) AS protein_g
       FROM nutrition_entries
       GROUP BY logged_date`,
    )
    .all() as { logged_date: string; kcal: number; protein_g: number }[];
  const byDate = new Map(rows.map((r) => [r.logged_date, r]));

  const out: { date: string; kcal: number; protein_g: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = nyDateString(d);
    const hit = byDate.get(key);
    out.push({
      date: key,
      kcal: hit ? Math.round(hit.kcal) : 0,
      protein_g: hit ? round1(hit.protein_g) : 0,
    });
  }

  const targets = nutritionTargets();
  return Response.json({
    days,
    history: out,
    target_kcal: targets.target_kcal,
    target_protein_g: targets.target_protein_g,
  });
}

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Replace an entry's items and recompute its header totals, in one transaction.
const replaceItemsTx = db.transaction((entryId: number, items: NutritionItem[]): void => {
  db.query("DELETE FROM nutrition_items WHERE entry_id = ?").run(entryId);
  const insertItem = db.query(
    `INSERT INTO nutrition_items (entry_id, food, quantity, kcal, protein_g, carbs_g, fat_g)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    insertItem.run(
      entryId,
      item.food,
      item.quantity,
      item.kcal,
      item.protein_g,
      item.carbs_g,
      item.fat_g,
    );
  }
  const totals = computeTotals(items);
  db.query(
    "UPDATE nutrition_entries SET kcal = ?, protein_g = ?, carbs_g = ?, fat_g = ? WHERE id = ?",
  ).run(totals.kcal, totals.protein_g, totals.carbs_g, totals.fat_g, entryId);
});

// PATCH /api/nutrition/:id (ISC-202) — edit entry-level fields (description,
// notes, logged_date) and/or replace items. Recomputes totals when items
// change, sets source='edited', bumps updated_at.
export async function updateNutrition(req: Request, idParam: string): Promise<Response> {
  const id = parseId(idParam);
  if (id === null) return jsonError("Invalid nutrition entry id", 400);

  const existing = db.query("SELECT * FROM nutrition_entries WHERE id = ?").get(id) as
    | NutritionEntryRow
    | null;
  if (existing === null) return jsonError("Nutrition entry not found", 404);

  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      return jsonError("description must be a string or null", 400);
    }
    if (typeof body.description === "string" && body.description.length > DESCRIPTION_MAX) {
      return jsonError(`description must be at most ${DESCRIPTION_MAX} characters`, 400);
    }
    sets.push("description = ?");
    params.push(body.description as string | null);
  }
  if ("notes" in body) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return jsonError("notes must be a string or null", 400);
    }
    if (typeof body.notes === "string" && body.notes.length > NOTES_MAX) {
      return jsonError(`notes must be at most ${NOTES_MAX} characters`, 400);
    }
    sets.push("notes = ?");
    params.push(body.notes as string | null);
  }
  if ("logged_date" in body) {
    if (!isValidYmd(body.logged_date)) return jsonError("logged_date must be YYYY-MM-DD", 400);
    sets.push("logged_date = ?");
    params.push(body.logged_date as string);
  }

  let newItems: NutritionItem[] | null = null;
  if ("items" in body) {
    const validated = validateItems(body.items);
    if (!validated.ok) return jsonError(validated.error, 400);
    newItems = validated.value;
  }

  if (sets.length === 0 && newItems === null) {
    return jsonError("No editable fields provided", 400);
  }

  // Every edit marks the entry as human-corrected (ISC-202, ISC-216) and bumps
  // updated_at.
  sets.push("source = ?");
  params.push("edited");
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  params.push(id);

  db.query(`UPDATE nutrition_entries SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  if (newItems !== null) {
    replaceItemsTx(id, newItems);
  }

  const row = db.query("SELECT * FROM nutrition_entries WHERE id = ?").get(id) as NutritionEntryRow;
  return Response.json({ entry: serializeEntry(row) });
}

// DELETE /api/nutrition/:id (ISC-203) — delete an entry; its items cascade
// away via the ON DELETE CASCADE foreign key.
export function deleteNutrition(_url: URL, idParam: string): Response {
  const id = parseId(idParam);
  if (id === null) return jsonError("Invalid nutrition entry id", 400);

  const existing = db.query("SELECT id FROM nutrition_entries WHERE id = ?").get(id) as
    | { id: number }
    | null;
  if (existing === null) return jsonError("Nutrition entry not found", 404);

  db.query("DELETE FROM nutrition_entries WHERE id = ?").run(id);
  return Response.json({ message: "Nutrition entry deleted." });
}
