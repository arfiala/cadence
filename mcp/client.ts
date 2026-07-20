// The thin HTTP client the MCP server uses to reach Cadence's API. This is
// the ENTIRE data layer of mcp/ — there is deliberately zero SQL and zero
// business logic anywhere under mcp/ (ISC-71). Every tool is a call to an
// already-authenticated API endpoint, so the web UI and the MCP surface are
// peers over one API by construction.

export type CadenceConfig = {
  url: string;
  token: string;
};

// Reads CADENCE_URL + CADENCE_TOKEN from env (ISC-68). A missing value is a
// clear thrown error at startup — the server refuses to start rather than
// crash-looping on every tool call.
export function readConfig(env: Record<string, string | undefined>): CadenceConfig {
  const url = env.CADENCE_URL;
  const token = env.CADENCE_TOKEN;
  if (url === undefined || url.length === 0) {
    throw new Error("CADENCE_URL is not set. Set it to your Cadence base URL, e.g. https://fit.austinfiala.com");
  }
  if (token === undefined || token.length === 0) {
    throw new Error("CADENCE_TOKEN is not set. Issue one on the box with: bun bin/issue-token.ts");
  }
  return { url: url.replace(/\/$/, ""), token };
}

export class CadenceApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CadenceApiError";
    this.status = status;
  }
}

// One request helper. The bearer token is ALWAYS sent in the Authorization
// header, NEVER in the URL (ISC-22). API failures surface as CadenceApiError
// with the server's message, which the tool layer turns into a readable MCP
// tool error rather than a stack trace (ISC-69).
export class CadenceClient {
  private config: CadenceConfig;

  constructor(config: CadenceConfig) {
    this.config = config;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.config.url}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CadenceApiError(
        `Could not reach Cadence at ${this.config.url}: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok) {
      const message =
        parsed !== null && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `Cadence API request failed (${res.status})`;
      throw new CadenceApiError(message, res.status);
    }

    return parsed;
  }

  getWeek(date?: string): Promise<unknown> {
    const qs = date !== undefined ? `?date=${encodeURIComponent(date)}` : "";
    return this.request("GET", `/api/week${qs}`);
  }

  listActivities(params: {
    from?: string;
    to?: string;
    sport?: string;
    limit?: number;
  }): Promise<unknown> {
    const search = new URLSearchParams();
    if (params.from !== undefined) search.set("from", params.from);
    if (params.to !== undefined) search.set("to", params.to);
    if (params.sport !== undefined) search.set("sport", params.sport);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const qs = search.toString();
    return this.request("GET", `/api/activities${qs.length > 0 ? `?${qs}` : ""}`);
  }

  createActivity(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/activities", body);
  }

  updateActivity(id: number, fields: unknown): Promise<unknown> {
    return this.request("PATCH", `/api/activities/${id}`, fields);
  }

  deleteActivity(id: number, confirm: boolean): Promise<unknown> {
    const qs = confirm ? "?confirm=true" : "";
    return this.request("DELETE", `/api/activities/${id}${qs}`);
  }

  triggerSync(): Promise<unknown> {
    return this.request("POST", "/api/sync");
  }

  getSyncStatus(): Promise<unknown> {
    return this.request("GET", "/api/sync/status");
  }

  getSleep(): Promise<unknown> {
    return this.request("GET", "/api/sleep");
  }

  getRaceResults(): Promise<unknown> {
    return this.request("GET", "/api/zwiftpower/results");
  }

  getTrainingLoad(): Promise<unknown> {
    return this.request("GET", "/api/metrics/training-load");
  }

  getWeekDigest(): Promise<unknown> {
    return this.request("GET", "/api/metrics/digest");
  }

  // Nutrition (ISC-207): the same HTTP API the web UI uses, so UI and MCP stay
  // peers over one API.
  logNutrition(body: unknown): Promise<unknown> {
    return this.request("POST", "/api/nutrition", body);
  }

  getNutritionDay(date?: string): Promise<unknown> {
    const qs = date !== undefined ? `?date=${encodeURIComponent(date)}` : "";
    return this.request("GET", `/api/nutrition${qs}`);
  }

  editNutrition(id: number, fields: unknown): Promise<unknown> {
    return this.request("PATCH", `/api/nutrition/${id}`, fields);
  }

  deleteNutrition(id: number): Promise<unknown> {
    return this.request("DELETE", `/api/nutrition/${id}`);
  }
}
