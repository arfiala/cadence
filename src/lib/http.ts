// Small HTTP helpers shared across routes. Kept dependency-free (no web
// framework — Bun.serve directly, per the ISA's "trust the framework"
// constraint).

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function readJsonBody(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// HTML-escape user-controlled content before it is ever interpolated into a
// server-rendered response. Cadence's only server-rendered HTML is the
// static app shell (public/index.html served as-is, no interpolation), but
// this lives here for any future template path and for the client-side
// escapeHtml the app page ships (kept as the same semantics, ISC-54).
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
