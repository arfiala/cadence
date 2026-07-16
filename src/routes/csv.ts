// POST /api/import/csv (ISC-99): the documented Garmin-outage survival path.
// Accepts either a raw text/csv body or a multipart/form-data upload with a
// "file" field. Columns: date,sport,duration_minutes,distance_km,notes —
// distance_km and notes are optional; everything else is required. Rows are
// inserted as source='manual' (a CSV import is a human-provided record, not
// a Garmin one, so it never participates in the Garmin merge policy).
//
// Hand-rolled CSV parsing (no csv-parse dependency — Cadence's runtime
// dependency budget is exactly the Garmin client + the MCP SDK) supporting
// the RFC4180 subset actually needed here: comma-separated fields,
// optionally double-quoted, with "" as an escaped quote inside a quoted
// field. Good enough for a notes column that might contain a comma.

import { db, isValidSport } from "../db";
import { jsonError } from "../lib/http";

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(text: string): string[][] {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
  return lines.map(parseCsvLine);
}

type ImportSkip = { row: number; reason: string };

async function extractCsvText(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (file instanceof Blob) {
        return await file.text();
      }
      return null;
    } catch {
      return null;
    }
  }
  try {
    return await req.text();
  } catch {
    return null;
  }
}

export async function importCsv(req: Request): Promise<Response> {
  const text = await extractCsvText(req);
  if (text === null || text.trim().length === 0) {
    return jsonError("No CSV content found in request body or 'file' field", 400);
  }

  const rows = parseCsv(text);
  if (rows.length === 0) {
    return jsonError("CSV is empty", 400);
  }

  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const requiredColumns = ["date", "sport", "duration_minutes"];
  for (const col of requiredColumns) {
    if (!header.includes(col)) {
      return jsonError(`CSV header is missing required column '${col}'`, 400);
    }
  }
  const idx = {
    date: header.indexOf("date"),
    sport: header.indexOf("sport"),
    duration_minutes: header.indexOf("duration_minutes"),
    distance_km: header.indexOf("distance_km"),
    notes: header.indexOf("notes"),
  };

  const insert = db.query(
    `INSERT INTO activities (source, sport, start_time, duration_s, distance_m, notes)
     VALUES ('manual', ?, ?, ?, ?, ?)`,
  );

  let imported = 0;
  const skipped: ImportSkip[] = [];

  for (let i = 1; i < rows.length; i++) {
    const rowNum = i + 1; // 1-indexed, header is row 1
    const cols = rows[i];
    if (cols === undefined) continue;

    const dateStr = cols[idx.date]?.trim();
    const sportStr = cols[idx.sport]?.trim();
    const durationStr = cols[idx.duration_minutes]?.trim();
    const distanceStr = idx.distance_km >= 0 ? cols[idx.distance_km]?.trim() : undefined;
    const notesStr = idx.notes >= 0 ? cols[idx.notes]?.trim() : undefined;

    if (dateStr === undefined || dateStr.length === 0) {
      skipped.push({ row: rowNum, reason: "missing date" });
      continue;
    }
    const startTime = new Date(dateStr);
    if (Number.isNaN(startTime.getTime())) {
      skipped.push({ row: rowNum, reason: `invalid date '${dateStr}'` });
      continue;
    }

    if (sportStr === undefined || !isValidSport(sportStr)) {
      skipped.push({ row: rowNum, reason: `invalid sport '${sportStr ?? ""}'` });
      continue;
    }

    const durationMinutes = Number(durationStr);
    if (durationStr === undefined || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      skipped.push({ row: rowNum, reason: `invalid duration_minutes '${durationStr ?? ""}'` });
      continue;
    }

    let distanceM: number | null = null;
    if (distanceStr !== undefined && distanceStr.length > 0) {
      const distanceKm = Number(distanceStr);
      if (!Number.isFinite(distanceKm) || distanceKm < 0) {
        skipped.push({ row: rowNum, reason: `invalid distance_km '${distanceStr}'` });
        continue;
      }
      distanceM = distanceKm * 1000;
    }

    insert.run(
      sportStr,
      startTime.toISOString(),
      Math.round(durationMinutes * 60),
      distanceM,
      notesStr !== undefined && notesStr.length > 0 ? notesStr : null,
    );
    imported += 1;
  }

  return Response.json({
    imported,
    skipped_count: skipped.length,
    skipped,
    total_rows: rows.length - 1,
  });
}
