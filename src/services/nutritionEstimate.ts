// Nutrition estimation service (ISC-194..198). Turns a free-text meal
// description ("two eggs, toast with butter, black coffee") into an itemized
// list of {food, quantity, kcal, protein_g, carbs_g, fat_g} by making ONE
// direct HTTPS fetch to the Anthropic Messages API.
//
// Hard boundaries, by design:
//   - The API key comes ONLY from ANTHROPIC_API_KEY in the box .env. With no
//     key set the service returns { ok: false, reason: "no_key" } and NEVER
//     makes a network call and NEVER fabricates numbers (ISC-196).
//   - It uses a direct HTTPS fetch with the x-api-key header. It never spawns
//     the `claude` CLI, never shells out, never uses OAuth billing, and never
//     imports @anthropic-ai/sdk (ISC-197, ISC-198). fetch + stdlib only.
//   - Every model response is hard-parsed and every numeric field validated as
//     finite, non-negative, and within a sane range. A single bad field
//     rejects the WHOLE response as { ok: false, reason: "bad_response" } —
//     the caller is never handed a partially-trusted estimate (ISC-195).
//
// The fetch is injectable (`deps.fetchImpl`) and the key is injectable
// (`deps.apiKey`) so the whole service is unit-testable with a stub and tests
// never touch the real network (ISC-217).

export type NutritionItem = {
  food: string;
  quantity: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type EstimateResult =
  | { ok: true; items: NutritionItem[] }
  | { ok: false; reason: "no_key" | "llm_error" | "bad_response" };

export type EstimateDeps = {
  // Overrides GEMINI_API_KEY. An empty string or undefined means "no key".
  geminiKey?: string;
  // Overrides ANTHROPIC_API_KEY. An empty string or undefined means "no key".
  apiKey?: string | undefined;
  // Overrides the global fetch (tests pass a stub returning a Response).
  fetchImpl?: typeof fetch;
  // Overrides NUTRITION_MODEL / the default model id.
  model?: string;
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// Gemini support (Austin chose the free tier, 2026-07-23). The key rides the
// x-goog-api-key HEADER, never the ?key= query param Google's docs show:
// tokens in URLs leak into access logs (constitutional rule). Same
// never-fabricate contract: no key, bad response, or timeout all degrade to
// manual entry. GEMINI_API_KEY wins over ANTHROPIC_API_KEY when both exist
// (the free path is the one Austin asked for).
const GEMINI_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// gemini-flash-latest: Google retires pinned versions for NEW keys (live 404
// "no longer available to new users", 2026-07-23); the alias tracks current.
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

// Upper bound on a single estimation call. Estimation is interactive (a user is
// waiting on the entry), so a slow call should fail fast to the manual-entry
// fallback rather than hang the request.
const ESTIMATE_TIMEOUT_MS = 15000;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// Sane per-item ceilings. Anything beyond these is treated as a malformed
// model response rather than trusted, since a single food item never carries
// 20000 kcal or 5000 g of a macro.
const MAX_KCAL = 20000;
const MAX_MACRO_G = 5000;

function buildPrompt(description: string): string {
  return [
    "You are a nutrition estimator. Break the following meal description into",
    "its individual food items and estimate the nutrition for each.",
    "",
    "Return ONLY a JSON array (no prose, no markdown, no code fences). Each",
    "element must be an object with exactly these keys:",
    '  "food": string (the food name),',
    '  "quantity": string (a human portion like "2 large" or "1 cup", or "" if unknown),',
    '  "kcal": number (calories, a non-negative number),',
    '  "protein_g": number (grams of protein, non-negative),',
    '  "carbs_g": number (grams of carbohydrate, non-negative),',
    '  "fat_g": number (grams of fat, non-negative).',
    "",
    "Estimate reasonable per-item values. Do not include a total row.",
    "",
    `Meal: ${description}`,
  ].join("\n");
}

// Pull the model's text output from the Anthropic Messages API response shape:
// { content: [ { type: "text", text: "..." }, ... ] }. Returns null if the
// shape is not what we expect, which the caller treats as bad_response.
function extractText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first = content[0];
  if (typeof first !== "object" || first === null) return null;
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

// Tolerantly locate the JSON array in the model's text: accept a bare array, or
// one wrapped in ```json ... ``` fences, or with leading/trailing prose. We do
// NOT accept anything that is not a clean array of objects.
function parseJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced && typeof fenced[1] === "string") candidates.push(fenced[1].trim());
  const bracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (bracket !== -1 && lastBracket > bracket) {
    candidates.push(trimmed.slice(bracket, lastBracket + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function isSaneNumber(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
}

// Validate one raw item hard. Any failure returns null and the whole response
// is rejected by the caller (never partially trusted, ISC-195).
function validateItem(raw: unknown): NutritionItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.food !== "string" || r.food.trim().length === 0) return null;

  let quantity: string | null = null;
  if (r.quantity !== undefined && r.quantity !== null) {
    if (typeof r.quantity !== "string") return null;
    quantity = r.quantity.trim().length > 0 ? r.quantity : null;
  }

  if (!isSaneNumber(r.kcal, MAX_KCAL)) return null;
  if (!isSaneNumber(r.protein_g, MAX_MACRO_G)) return null;
  if (!isSaneNumber(r.carbs_g, MAX_MACRO_G)) return null;
  if (!isSaneNumber(r.fat_g, MAX_MACRO_G)) return null;

  return {
    food: r.food.trim(),
    quantity,
    kcal: r.kcal,
    protein_g: r.protein_g,
    carbs_g: r.carbs_g,
    fat_g: r.fat_g,
  };
}

// Gemini generateContent response shape: candidates[0].content.parts[].text.
function extractGeminiText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const cands = (payload as Record<string, unknown>).candidates;
  if (!Array.isArray(cands) || cands.length === 0) return null;
  const content = (cands[0] as Record<string, unknown>)?.content as
    | Record<string, unknown>
    | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (typeof (p as Record<string, unknown>)?.text === "string" ? (p as Record<string, unknown>).text : ""))
    .join("");
  return text.length > 0 ? text : null;
}

export async function estimateNutrition(
  description: string,
  deps: EstimateDeps = {},
): Promise<EstimateResult> {
  const geminiKey = deps.geminiKey !== undefined ? deps.geminiKey : process.env.GEMINI_API_KEY;
  const anthropicKey = deps.apiKey !== undefined ? deps.apiKey : process.env.ANTHROPIC_API_KEY;
  const provider =
    geminiKey !== undefined && geminiKey.length > 0
      ? ("gemini" as const)
      : anthropicKey !== undefined && anthropicKey.length > 0
        ? ("anthropic" as const)
        : null;
  // No key on either provider: the typed unavailable result, no call, no
  // fabricated numbers; the caller falls back to manual entry.
  if (provider === null) {
    return { ok: false, reason: "no_key" };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    if (provider === "gemini") {
      const model = deps.model ?? process.env.NUTRITION_MODEL ?? DEFAULT_GEMINI_MODEL;
      res = await fetchImpl(`${GEMINI_URL_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: {
          // Header, never the ?key= query param: tokens in URLs leak to logs.
          "x-goog-api-key": geminiKey as string,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(description) }] }],
          // 8192, not 1024: current flash models think before answering and
          // the thought consumes the output budget; 1024 truncated the JSON
          // mid-array (live repro 2026-07-23). thinkingBudget: 0 is a 400 on
          // this model, so headroom is the fix, not disabling thought.
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(ESTIMATE_TIMEOUT_MS),
      });
    } else {
      const model = deps.model ?? process.env.NUTRITION_MODEL ?? DEFAULT_MODEL;
      res = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey as string,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: buildPrompt(description) }],
        }),
        // Hard timeout so a hung connection fails to llm_error (which the
        // caller turns into a manual-entry fallback) rather than stalling the
        // request. Single attempt, no retry, so a 429/5xx cannot storm the API.
        signal: AbortSignal.timeout(ESTIMATE_TIMEOUT_MS),
      });
    }
  } catch {
    // Transport-level failure (DNS, connection reset, timeout).
    return { ok: false, reason: "llm_error" };
  }

  if (!res.ok) {
    // Any non-2xx from the API (auth, rate limit, server error).
    return { ok: false, reason: "llm_error" };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, reason: "bad_response" };
  }

  const text = provider === "gemini" ? extractGeminiText(payload) : extractText(payload);
  if (text === null) return { ok: false, reason: "bad_response" };

  const rawArray = parseJsonArray(text);
  if (rawArray === null || rawArray.length === 0) {
    return { ok: false, reason: "bad_response" };
  }

  const items: NutritionItem[] = [];
  for (const raw of rawArray) {
    const item = validateItem(raw);
    if (item === null) return { ok: false, reason: "bad_response" };
    items.push(item);
  }

  return { ok: true, items };
}
