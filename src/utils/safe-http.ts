import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Outbound POSTs to user-supplied URLs (webhooks) without SSRF: HTTPS only,
 * and every address the host resolves to is checked when the connection is
 * made, so private, loopback, link-local and cloud metadata addresses are
 * refused even if DNS changes between check and use.
 */

export class UnsafeUrlError extends Error {}

/** True for addresses a webhook must never reach. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export interface SafeUrlOptions {
  /** Local development only: allow http:// and private addresses. */
  allowPrivate?: boolean;
}

/** Validates the URL's form; addresses are checked when connecting. */
export function assertSafeUrl(raw: string, options: SafeUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Enter a full URL, starting with https://");
  }
  if (
    url.protocol !== "https:" &&
    !(options.allowPrivate && url.protocol === "http:")
  )
    throw new UnsafeUrlError("Only https:// URLs are allowed");
  if (url.username || url.password)
    throw new UnsafeUrlError(
      "URLs with a user name or password are not allowed",
    );
  if (
    !options.allowPrivate &&
    net.isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
    isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))
  )
    throw new UnsafeUrlError("Private and local addresses are not allowed");
  if (
    !options.allowPrivate &&
    /^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)
  )
    throw new UnsafeUrlError("Private and local addresses are not allowed");
  return url;
}

const safeLookup =
  (allowPrivate: boolean): net.LookupFunction =>
  (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, "", 4);
      const list = addresses as dns.LookupAddress[];
      const bad = list.find(
        (entry) => !allowPrivate && isPrivateAddress(entry.address),
      );
      if (bad || list.length === 0) {
        return callback(
          new UnsafeUrlError("The webhook host resolves to a private address"),
          "",
          4,
        );
      }
      if ((options as { all?: boolean }).all) {
        return (
          callback as unknown as (e: null, a: dns.LookupAddress[]) => void
        )(null, list);
      }
      callback(null, list[0].address, list[0].family);
    });
  };

export interface SafePostResult {
  status: number;
  /** First 500 characters of the response body. */
  body: string;
}

/** POSTs a body with a timeout; resolves with the status, rejects on network errors. */
export function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  options: SafeUrlOptions & { timeoutMs?: number } = {},
): Promise<SafePostResult> {
  const url = assertSafeUrl(rawUrl, options);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body).toString(),
          "user-agent": "Pristine-Webhooks/1.0",
          ...headers,
        },
        lookup: safeLookup(Boolean(options.allowPrivate)),
        timeout: options.timeoutMs ?? 5000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (text.length < 500) text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: text.slice(0, 500),
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", reject);
    request.end(body);
  });
}
