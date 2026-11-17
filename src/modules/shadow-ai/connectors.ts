import { createHash, createHmac, createSign } from "node:crypto";

import type { RawSignal } from "./signals.js";

/**
 * Pulls the apps people have connected to their work accounts, so shadow AI is
 * found without anyone pasting a log. Each client takes an injectable `fetch`
 * and base URLs so it can be tested against a stub server.
 *
 * Google Workspace: a service account with domain-wide delegation lists each
 * user's OAuth tokens (Admin SDK Directory API).
 * Microsoft Entra: an app registration with the client-credentials flow lists
 * delegated permission grants (Microsoft Graph).
 */

export type Fetch = typeof fetch;

export interface GoogleCredentials {
  serviceAccountEmail: string;
  privateKey: string;
  adminEmail: string;
}
export interface MicrosoftCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface AzureCredentials extends MicrosoftCredentials {
  subscriptionId: string;
}
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Comma-separated regions to look in. */
  regions: string;
}

export interface Endpoints {
  googleToken: string;
  googleDirectory: string;
  microsoftLogin: string;
  microsoftGraph: string;
  azureArm: string;
  /** Replaces https://{service}.{region}.amazonaws.com; the service name is added as the first path segment. Tests only. */
  awsOverride: string;
}

/** The real services. Environment variables point them elsewhere for tests and sovereign clouds (e.g. Microsoft 365 GCC High). */
export const DEFAULT_ENDPOINTS: Endpoints = {
  googleToken:
    process.env.SHADOW_AI_GOOGLE_TOKEN_URL ||
    "https://oauth2.googleapis.com/token",
  googleDirectory:
    process.env.SHADOW_AI_GOOGLE_DIRECTORY_URL ||
    "https://admin.googleapis.com/admin/directory/v1",
  microsoftLogin:
    process.env.SHADOW_AI_MICROSOFT_LOGIN_URL ||
    "https://login.microsoftonline.com",
  microsoftGraph:
    process.env.SHADOW_AI_MICROSOFT_GRAPH_URL ||
    "https://graph.microsoft.com/v1.0",
  azureArm:
    process.env.SHADOW_AI_AZURE_ARM_URL || "https://management.azure.com",
  awsOverride: process.env.SHADOW_AI_AWS_URL || "",
};

export const MAX_USERS = 2000;
const MAX_PAGES = 40;

const b64url = (v: Buffer | string): string =>
  Buffer.from(v).toString("base64url");

async function json(
  res: Response,
  what: string,
): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) {
    // Keep the provider's reason, never the request (which held credentials).
    let reason = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as {
        error?: { message?: string } | string;
        error_description?: string;
      };
      reason =
        (typeof j.error === "object"
          ? j.error?.message
          : j.error_description || j.error) || reason;
    } catch {
      /* keep raw text */
    }
    throw new Error(
      `${what} failed (${res.status}): ${String(reason).slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${what} returned something that is not JSON`);
  }
}

/** A throw-away pool: runs `fn` over `items` with at most `n` in flight. */
async function pool<T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

// ---------------------------------------------------------------------------
// Google Workspace
// ---------------------------------------------------------------------------

export function parseGoogleKey(raw: string): GoogleCredentials {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("The service account file is not valid JSON");
  }
  const email = String(j.client_email ?? "");
  const key = String(j.private_key ?? "");
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !key.includes("BEGIN PRIVATE KEY"))
    throw new Error(
      "That does not look like a Google service account key (client_email and private_key are needed)",
    );
  return { serviceAccountEmail: email, privateKey: key, adminEmail: "" };
}

export function googleAssertion(
  c: GoogleCredentials,
  aud: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: c.serviceAccountEmail,
      sub: c.adminEmail,
      scope:
        "https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.user.security",
      aud,
      iat: now,
      exp: now + 3000,
    }),
  );
  const sig = createSign("RSA-SHA256")
    .update(`${head}.${claims}`)
    .sign(c.privateKey);
  return `${head}.${claims}.${b64url(sig)}`;
}

export async function pullGoogle(
  c: GoogleCredentials,
  ep: Endpoints = DEFAULT_ENDPOINTS,
  f: Fetch = fetch,
): Promise<{ signals: RawSignal[]; users: number; truncated: boolean }> {
  const tokenRes = await f(ep.googleToken, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: googleAssertion(c, ep.googleToken),
    }),
  });
  const token = String(
    (await json(tokenRes, "Google sign-in")).access_token ?? "",
  );
  if (!token) throw new Error("Google did not return an access token");
  const auth = { authorization: `Bearer ${token}` };

  const emails: string[] = [];
  let page: string | undefined;
  for (let p = 0; p < MAX_PAGES && emails.length < MAX_USERS; p++) {
    const url = new URL(`${ep.googleDirectory}/users`);
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set(
      "fields",
      "nextPageToken,users(primaryEmail,suspended)",
    );
    if (page) url.searchParams.set("pageToken", page);
    const body = await json(
      await f(url, { headers: auth }),
      "Listing Google users",
    );
    for (const u of (body.users as
      | Array<{ primaryEmail?: string; suspended?: boolean }>
      | undefined) ?? []) {
      if (u.primaryEmail && !u.suspended) emails.push(u.primaryEmail);
    }
    page = body.nextPageToken as string | undefined;
    if (!page) break;
  }
  const truncated = emails.length >= MAX_USERS || !!page;
  const users = emails.slice(0, MAX_USERS);

  const signals: RawSignal[] = [];
  let firstError: Error | null = null;
  let failed = 0;
  await pool(users, 5, async (email) => {
    try {
      const body = await json(
        await f(
          `${ep.googleDirectory}/users/${encodeURIComponent(email)}/tokens`,
          { headers: auth },
        ),
        "Listing a user's apps",
      );
      for (const t of (body.items as
        | Array<{ displayText?: string; scopes?: string[] }>
        | undefined) ?? []) {
        if (t.displayText)
          signals.push({
            target: t.displayText,
            user: email,
            scopes: t.scopes ?? [],
          });
      }
    } catch (e) {
      failed += 1;
      firstError ??= e as Error;
    }
  });
  // One user failing is noise; all failing means the delegation is not set up.
  if (users.length && failed === users.length && firstError) throw firstError;
  return { signals, users: users.length, truncated };
}

// ---------------------------------------------------------------------------
// Microsoft Entra
// ---------------------------------------------------------------------------

async function graphPages(
  f: Fetch,
  first: string,
  headers: Record<string, string>,
  what: string,
  cap = MAX_PAGES,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let next: string | undefined = first;
  for (let p = 0; next && p < cap; p++) {
    const body = await json(await f(next, { headers }), what);
    out.push(
      ...((body.value as Array<Record<string, unknown>> | undefined) ?? []),
    );
    next = body["@odata.nextLink"] as string | undefined;
  }
  return out;
}

export async function pullMicrosoft(
  c: MicrosoftCredentials,
  ep: Endpoints = DEFAULT_ENDPOINTS,
  f: Fetch = fetch,
): Promise<{ signals: RawSignal[]; users: number; truncated: boolean }> {
  if (
    !/^[0-9a-f-]{36}$/i.test(c.tenantId) &&
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.tenantId)
  )
    throw new Error("The tenant must be a directory ID or a domain");
  const tokenRes = await f(
    `${ep.microsoftLogin}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  const token = String(
    (await json(tokenRes, "Microsoft sign-in")).access_token ?? "",
  );
  if (!token) throw new Error("Microsoft did not return an access token");
  const auth = { authorization: `Bearer ${token}` };

  const grants = await graphPages(
    f,
    `${ep.microsoftGraph}/oauth2PermissionGrants?$top=999`,
    auth,
    "Listing Microsoft grants",
  );
  const apps = await graphPages(
    f,
    `${ep.microsoftGraph}/servicePrincipals?$select=id,displayName&$top=999`,
    auth,
    "Listing Microsoft apps",
  );
  const name = new Map(
    apps.map((a) => [String(a.id), String(a.displayName ?? "")]),
  );

  const principals = [
    ...new Set(
      grants
        .filter((g) => g.consentType === "Principal" && g.principalId)
        .map((g) => String(g.principalId)),
    ),
  ].slice(0, MAX_USERS);
  const email = new Map<string, string>();
  await pool(principals, 5, async (id) => {
    try {
      const u = await json(
        await f(
          `${ep.microsoftGraph}/users/${encodeURIComponent(id)}?$select=mail,userPrincipalName`,
          { headers: auth },
        ),
        "Reading a user",
      );
      const e = String(u.mail || u.userPrincipalName || "");
      if (e) email.set(id, e.toLowerCase());
    } catch {
      /* a deleted user: the grant stays, the person is unknown */
    }
  });

  const signals: RawSignal[] = [];
  for (const g of grants) {
    const app = name.get(String(g.clientId));
    if (!app) continue;
    signals.push({
      target: app,
      // A grant for everyone is not tied to one person.
      user:
        g.consentType === "Principal"
          ? email.get(String(g.principalId))
          : undefined,
      scopes: String(g.scope ?? "")
        .split(/\s+/)
        .filter(Boolean),
    });
  }
  return {
    signals,
    users: principals.length,
    truncated: grants.length >= 999 * MAX_PAGES,
  };
}

// ---------------------------------------------------------------------------
// Azure: AI resources in a subscription
// ---------------------------------------------------------------------------

/**
 * Lists Azure AI resources (Azure OpenAI and AI Services accounts). This finds
 * AI that has been deployed, not calls made to it. The app registration needs
 * the Reader role on the subscription.
 */
export async function pullAzure(
  c: AzureCredentials,
  ep: Endpoints = DEFAULT_ENDPOINTS,
  f: Fetch = fetch,
): Promise<{ signals: RawSignal[]; users: number; truncated: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(c.subscriptionId))
    throw new Error("The subscription ID must be a GUID");
  if (
    !/^[0-9a-f-]{36}$/i.test(c.tenantId) &&
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(c.tenantId)
  )
    throw new Error("The tenant must be a directory ID or a domain");
  const tokenRes = await f(
    `${ep.microsoftLogin}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        scope: "https://management.azure.com/.default",
      }),
    },
  );
  const token = String(
    (await json(tokenRes, "Azure sign-in")).access_token ?? "",
  );
  if (!token) throw new Error("Azure did not return an access token");
  const accounts = await graphPages(
    f,
    `${ep.azureArm}/subscriptions/${c.subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2023-05-01`,
    { authorization: `Bearer ${token}` },
    "Listing Azure AI resources",
  );
  const signals: RawSignal[] = [];
  for (const a of accounts) {
    const kind = String(a.kind ?? "");
    if (!/^(OpenAI|AIServices)$/i.test(kind)) continue;
    signals.push({
      target: "Azure OpenAI",
      detail: `${String(a.name ?? "account")} (${kind}, ${String(a.location ?? "unknown region")})`,
    });
  }
  return { signals, users: 0, truncated: false };
}

// ---------------------------------------------------------------------------
// AWS: Bedrock and SageMaker resources
// ---------------------------------------------------------------------------

const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");
const hmac = (key: Buffer | string, v: string): Buffer =>
  createHmac("sha256", key).update(v).digest();

/** AWS Signature Version 4 for one request. Returns the headers to send. */
export function signAws(opts: {
  method: string;
  url: URL;
  service: string;
  region: string;
  body: string;
  creds: Pick<AwsCredentials, "accessKeyId" | "secretAccessKey">;
  headers?: Record<string, string>;
  now?: Date;
  payloadHeader?: boolean;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...(opts.headers ?? {}),
    host: opts.url.host,
    "x-amz-date": amzDate,
    ...(opts.payloadHeader === false
      ? {}
      : { "x-amz-content-sha256": sha256(opts.body) }),
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
  );
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const query = [...opts.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonical = [
    opts.method,
    opts.url.pathname || "/",
    query,
    canonicalHeaders,
    names.join(";"),
    sha256(opts.body),
  ].join("\n");
  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join(
    "\n",
  );
  const key = hmac(
    hmac(
      hmac(hmac(`AWS4${opts.creds.secretAccessKey}`, date), opts.region),
      opts.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

function awsUrl(
  ep: Endpoints,
  service: string,
  region: string,
  path: string,
): URL {
  return ep.awsOverride
    ? new URL(`${ep.awsOverride}/${service}${path}`)
    : new URL(`https://${service}.${region}.amazonaws.com${path}`);
}

/**
 * Lists deployed AI resources: Bedrock custom models and provisioned
 * throughput, SageMaker endpoints. This finds AI that is set up, not calls
 * made to it. The access key needs read-only List permissions for these.
 */
export async function pullAws(
  c: AwsCredentials,
  ep: Endpoints = DEFAULT_ENDPOINTS,
  f: Fetch = fetch,
): Promise<{ signals: RawSignal[]; users: number; truncated: boolean }> {
  const regions = c.regions
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (
    !regions.length ||
    regions.length > 8 ||
    regions.some((r) => !/^[a-z]{2}(-[a-z]+)+-\d$/.test(r))
  )
    throw new Error(
      "Give 1 to 8 AWS regions such as us-east-1, separated by commas",
    );
  if (!/^[A-Z0-9]{16,128}$/.test(c.accessKeyId))
    throw new Error("That does not look like an AWS access key ID");
  const signals: RawSignal[] = [];
  let ok = 0;
  let firstError: Error | null = null;
  const call = async (
    service: string,
    region: string,
    method: "GET" | "POST",
    path: string,
    body = "",
    extra: Record<string, string> = {},
  ) => {
    const url = awsUrl(ep, service, region, path);
    const headers = signAws({
      method,
      url,
      service,
      region,
      body,
      creds: c,
      headers: extra,
    });
    return json(
      await f(url, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
      }),
      `AWS ${service}`,
    );
  };
  for (const region of regions) {
    try {
      const custom = await call("bedrock", region, "GET", "/custom-models");
      for (const m of (custom.modelSummaries as
        | Array<{ modelName?: string }>
        | undefined) ?? [])
        signals.push({
          target: "Amazon Bedrock",
          detail: `custom model ${m.modelName ?? "unnamed"} (${region})`,
        });
      const prov = await call(
        "bedrock",
        region,
        "GET",
        "/provisioned-model-throughputs",
      );
      for (const m of (prov.provisionedModelSummaries as
        | Array<{ provisionedModelName?: string }>
        | undefined) ?? [])
        signals.push({
          target: "Amazon Bedrock",
          detail: `provisioned ${m.provisionedModelName ?? "unnamed"} (${region})`,
        });
      ok += 1;
    } catch (e) {
      firstError ??= e as Error;
    }
    try {
      const body = "{}";
      const eps = await call("sagemaker", region, "POST", "/", body, {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "SageMaker.ListEndpoints",
      });
      for (const m of (eps.Endpoints as
        | Array<{ EndpointName?: string }>
        | undefined) ?? [])
        signals.push({
          target: "Amazon SageMaker",
          detail: `endpoint ${m.EndpointName ?? "unnamed"} (${region})`,
        });
      ok += 1;
    } catch (e) {
      firstError ??= e as Error;
    }
  }
  // Some services may simply be switched off in a region; nothing working at all means the key is wrong.
  if (!ok && firstError) throw firstError;
  return { signals, users: 0, truncated: false };
}
