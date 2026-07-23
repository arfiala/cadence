// Nutrition estimation service tests (ISC-194..198, ISC-217). Every case uses
// an injected fake fetch or an injected key, so NO real network call is ever
// made. Covers: the success parse path, malformed JSON, out-of-range numbers,
// the no-key guard (never calls out), HTTP failures, and tolerant parsing.

import { test, expect, describe } from "bun:test";
import { estimateNutrition } from "../src/services/nutritionEstimate";

// Build a fake fetch that returns an Anthropic-shaped response whose single
// text block is `text`, with the given HTTP status.
function fetchReturning(text: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status,
    })) as unknown as typeof fetch;
}

const GOOD_ITEMS = JSON.stringify([
  { food: "scrambled eggs", quantity: "2 large", kcal: 180, protein_g: 12, carbs_g: 1, fat_g: 13 },
  { food: "buttered toast", quantity: "1 slice", kcal: 120, protein_g: 3, carbs_g: 15, fat_g: 5 },
]);

describe("no key (ISC-196)", () => {
  test("returns no_key and never calls fetch when the key is empty", async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      throw new Error("fetch should never be called without a key");
    }) as unknown as typeof fetch;

    const result = await estimateNutrition("two eggs", { apiKey: "", fetchImpl: spyFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_key");
    expect(called).toBe(false);
  });
});

describe("success parse (ISC-194)", () => {
  test("parses items and normalizes an empty quantity to null", async () => {
    const result = await estimateNutrition("eggs and toast", {
      apiKey: "k",
      fetchImpl: fetchReturning(GOOD_ITEMS),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items.length).toBe(2);
      expect(result.items[0]!.food).toBe("scrambled eggs");
      expect(result.items[0]!.kcal).toBe(180);
    }
  });

  test("tolerates a json code-fence around the array", async () => {
    const fenced = "```json\n" + GOOD_ITEMS + "\n```";
    const result = await estimateNutrition("eggs and toast", {
      apiKey: "k",
      fetchImpl: fetchReturning(fenced),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.length).toBe(2);
  });

  test("empty quantity string becomes null", async () => {
    const items = JSON.stringify([{ food: "water", quantity: "", kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }]);
    const result = await estimateNutrition("water", { apiKey: "k", fetchImpl: fetchReturning(items) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]!.quantity).toBeNull();
  });
});

describe("bad response (ISC-195)", () => {
  test("malformed JSON text is rejected", async () => {
    const result = await estimateNutrition("meal", {
      apiKey: "k",
      fetchImpl: fetchReturning("not json at all, sorry"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });

  test("a non-array JSON payload is rejected", async () => {
    const result = await estimateNutrition("meal", {
      apiKey: "k",
      fetchImpl: fetchReturning(JSON.stringify({ food: "eggs" })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });

  test("an empty array is rejected (no items estimated)", async () => {
    const result = await estimateNutrition("meal", { apiKey: "k", fetchImpl: fetchReturning("[]") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });

  test("a negative number rejects the whole response", async () => {
    const bad = JSON.stringify([{ food: "eggs", quantity: "2", kcal: -50, protein_g: 12, carbs_g: 1, fat_g: 10 }]);
    const result = await estimateNutrition("meal", { apiKey: "k", fetchImpl: fetchReturning(bad) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });

  test("an out-of-range kcal rejects the whole response", async () => {
    const bad = JSON.stringify([{ food: "eggs", quantity: "2", kcal: 999999, protein_g: 12, carbs_g: 1, fat_g: 10 }]);
    const result = await estimateNutrition("meal", { apiKey: "k", fetchImpl: fetchReturning(bad) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });

  test("a non-finite number rejects the whole response", async () => {
    // JSON has no NaN literal, so simulate the model returning a string number.
    const bad = JSON.stringify([{ food: "eggs", quantity: "2", kcal: "lots", protein_g: 12, carbs_g: 1, fat_g: 10 }]);
    const result = await estimateNutrition("meal", { apiKey: "k", fetchImpl: fetchReturning(bad) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });

  test("a missing food name rejects the whole response", async () => {
    const bad = JSON.stringify([{ quantity: "2", kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1 }]);
    const result = await estimateNutrition("meal", { apiKey: "k", fetchImpl: fetchReturning(bad) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_response");
  });
});

describe("llm error (ISC-196)", () => {
  test("a non-2xx HTTP status returns llm_error", async () => {
    const result = await estimateNutrition("meal", {
      apiKey: "k",
      fetchImpl: fetchReturning(GOOD_ITEMS, 500),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("llm_error");
  });

  test("a thrown fetch (transport failure) returns llm_error", async () => {
    const throwing = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const result = await estimateNutrition("meal", { apiKey: "k", fetchImpl: throwing });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("llm_error");
  });
});

// --- Gemini provider (free tier, 2026-07-23) ---------------------------
import { describe as gDescribe, test as gTest, expect as gExpect } from "bun:test";

const GEMINI_OK = {
  candidates: [
    {
      content: {
        parts: [
          { text: '[{"food":"two eggs","quantity":"2 large","kcal":140,"protein_g":12,"carbs_g":1,"fat_g":10}]' },
        ],
      },
    },
  ],
};

gDescribe("gemini provider", () => {
  gTest("gemini key routes to generateContent with header auth, never URL key", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify(GEMINI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await estimateNutrition("two eggs", { geminiKey: "g-key", apiKey: "", fetchImpl });
    gExpect(r.ok).toBe(true);
    if (r.ok) gExpect(r.items[0]!.kcal).toBe(140);
    gExpect(seenUrl).toContain(":generateContent");
    gExpect(seenUrl.includes("key=")).toBe(false);
    gExpect(seenHeaders["x-goog-api-key"]).toBe("g-key");
  });
  gTest("gemini wins over anthropic when both keys exist", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string) => {
      seenUrl = String(url);
      return new Response(JSON.stringify(GEMINI_OK), { status: 200 });
    }) as unknown as typeof fetch;
    await estimateNutrition("toast", { geminiKey: "g", apiKey: "a", fetchImpl });
    gExpect(seenUrl).toContain("generativelanguage.googleapis.com");
  });
  gTest("no keys still degrades to manual (no_key), no fetch made", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await estimateNutrition("toast", { geminiKey: "", apiKey: "", fetchImpl });
    gExpect(r).toEqual({ ok: false, reason: "no_key" });
    gExpect(called).toBe(false);
  });
  gTest("malformed gemini payload degrades to bad_response, never fabricates", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const r = await estimateNutrition("mystery", { geminiKey: "g", fetchImpl });
    gExpect(r).toEqual({ ok: false, reason: "bad_response" });
  });
});
