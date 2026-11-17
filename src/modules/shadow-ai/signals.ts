import {
  hostnameOf,
  looksLikeAi,
  matchHost,
  matchName,
  slugify,
  type CatalogTool,
} from "./catalog.js";

/**
 * Turns raw evidence (a proxy log line, an OAuth grant, a cloud service, an
 * expense row) into "this person used this AI tool". Pure.
 */

export const SOURCES = [
  "network",
  "oauth",
  "cloud",
  "code",
  "extension",
  "expense",
  "declared",
  "agent",
] as const;
export type Source = (typeof SOURCES)[number];

export interface RawSignal {
  /** Where it happened: a hostname or URL, an app name, a package name. */
  target: string;
  user?: string;
  at?: Date;
  bytesOut?: number;
  uploads?: number;
  /** A personal (not company) account was used. */
  personal?: boolean;
  /** OAuth scopes granted, or permissions of the install. */
  scopes?: string[];
}

export interface Resolved {
  toolKey: string;
  name: string;
  vendor: string;
  kind: CatalogTool["kind"];
  catalog: boolean;
  /** 1 when the catalog knows it, lower when guessed from the name. */
  confidence: number;
}

export function resolveTarget(source: Source, target: string): Resolved | null {
  const raw = String(target ?? "").trim();
  if (!raw) return null;
  const host =
    source === "network" || source === "extension" || source === "oauth"
      ? hostnameOf(raw)
      : null;
  if (host) {
    const hit = matchHost(host);
    if (hit)
      return {
        toolKey: hit.key,
        name: hit.name,
        vendor: hit.vendor,
        kind: hit.kind,
        catalog: true,
        confidence: 1,
      };
    if (source === "network" && looksLikeAi(host)) {
      return {
        toolKey: `host_${slugify(host)}`,
        name: host,
        vendor: host,
        kind: "unknown",
        catalog: false,
        confidence: 0.4,
      };
    }
    if (source !== "network") return fromName(raw);
    return null;
  }
  return fromName(raw);
}

function fromName(raw: string): Resolved | null {
  const hit = matchName(raw);
  if (hit)
    return {
      toolKey: hit.key,
      name: hit.name,
      vendor: hit.vendor,
      kind: hit.kind,
      catalog: true,
      confidence: 0.9,
    };
  // Unknown names only count when they say they are AI; otherwise every OAuth app would land here.
  if (!/\b(ai|gpt|llm|copilot|assistant|chatbot|agent)\b/i.test(raw))
    return null;
  const name = raw.slice(0, 120);
  return {
    toolKey: `app_${slugify(name)}`,
    name,
    vendor: name,
    kind: "unknown",
    catalog: false,
    confidence: 0.4,
  };
}

const BROAD_SCOPES = [
  /mail/i,
  /gmail/i,
  /drive/i,
  /files\.read/i,
  /calendar/i,
  /sites\.read/i,
  /offline_access/i,
  /\.all$/i,
  /full_access|admin/i,
];
export const isBroadGrant = (scopes: string[] | undefined): boolean =>
  !!scopes?.some((s) => BROAD_SCOPES.some((r) => r.test(s)));

// ---------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------

/**
 * One line from a proxy, DNS or firewall export. Understands CSV with a
 * header (host/url/domain, user, bytes, time) and plain "host" lists. Unknown
 * columns are ignored so exports from Zscaler, Netskope, Squid or Cloudflare
 * work with a header row that names the columns.
 */
export function parseLogRows(
  text: string,
  max = 5000,
): { rows: RawSignal[]; skipped: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max + 1);
  if (!lines.length) return { rows: [], skipped: 0 };
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if ((ch === "," || ch === "\t") && !quoted) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const head = split(lines[0]).map((h) =>
    h.toLowerCase().replace(/[^a-z]/g, ""),
  );
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const hasHeader =
    col(
      "host",
      "hostname",
      "domain",
      "url",
      "destination",
      "destinationhost",
      "requesturl",
      "fqdn",
    ) >= 0;
  const iHost = hasHeader
    ? col(
        "host",
        "hostname",
        "domain",
        "url",
        "destination",
        "destinationhost",
        "requesturl",
        "fqdn",
      )
    : 0;
  const iUser = hasHeader
    ? col("user", "username", "email", "useremail", "principal", "upn")
    : -1;
  const iBytes = hasHeader
    ? col(
        "bytesout",
        "bytessent",
        "sentbytes",
        "uploadbytes",
        "bytes",
        "requestbytes",
      )
    : -1;
  const iTime = hasHeader
    ? col("time", "timestamp", "date", "datetime", "eventtime")
    : -1;
  const iUp = hasHeader ? col("uploads", "uploadcount", "fileuploads") : -1;
  const iPersonal = hasHeader
    ? col("personal", "personalaccount", "unmanaged")
    : -1;
  const rows: RawSignal[] = [];
  let skipped = 0;
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const cells = split(line);
    const target = cells[iHost] ?? "";
    if (!hostnameOf(target)) {
      skipped += 1;
      continue;
    }
    const num = (i: number) =>
      i >= 0 && Number.isFinite(Number(cells[i]))
        ? Math.max(0, Number(cells[i]))
        : 0;
    const when =
      iTime >= 0 && cells[iTime]
        ? new Date(
            /^\d+$/.test(cells[iTime])
              ? Number(cells[iTime]) * (cells[iTime].length <= 10 ? 1000 : 1)
              : cells[iTime],
          )
        : undefined;
    rows.push({
      target,
      user:
        iUser >= 0
          ? cells[iUser]?.toLowerCase().slice(0, 200) || undefined
          : undefined,
      bytesOut: num(iBytes),
      uploads: num(iUp),
      personal:
        iPersonal >= 0
          ? /^(1|true|yes)$/i.test(cells[iPersonal] ?? "")
          : undefined,
      at:
        when &&
        !Number.isNaN(when.getTime()) &&
        when.getTime() <= Date.now() + 86_400_000
          ? when
          : undefined,
    });
  }
  return { rows, skipped };
}
