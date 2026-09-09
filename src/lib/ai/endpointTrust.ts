/**
 * Guessing whether an inference endpoint is the user's own infrastructure.
 *
 * **A guess, and only ever a pre-fill.** The stored value is the user's
 * declaration — see `EndpointTrust` in `src-tauri/src/ai/scope.rs`, which
 * explains why: `ai-internal` is a hostname, DNS resolves it wherever DNS
 * says, and a trust rule derived from a resolver's answer is a rule anyone on
 * the network gets to edit. What this function buys is that the common cases
 * (loopback, a LAN box) do not make the user think about a security question
 * whose answer is obvious.
 *
 * Pure and string-only: no DNS lookup, no `fetch`. That is the point — a
 * resolution here would be both slower and less honest than asking.
 */

import type { AiEndpointTrust } from "@/types";

/** Loopback, by name or by address. */
function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    // 127.0.0.0/8 — the whole block, not just 127.0.0.1.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** RFC1918 and the link-local block a docker/VM bridge hands out. */
function isPrivateV4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // 169.254/16: link-local, which is what a machine with no DHCP lease has.
    (a === 169 && b === 254)
  );
}

/**
 * A hostname that cannot leave the local network: mDNS (`.local`), the
 * conventional intranet suffixes, and a bare single-label name — which only
 * resolves through a local resolver or `hosts`, and is exactly how the shared
 * LAN box in the roadmap's deployment pattern (`http://ai-internal:11434/v1`)
 * is addressed.
 */
function isLocalName(host: string): boolean {
  if (!host.includes(".")) return true;
  return [".local", ".lan", ".internal", ".home", ".intranet"].some((suffix) =>
    host.endsWith(suffix),
  );
}

/**
 * The trust level to pre-fill for `baseUrl`.
 *
 * Returns `"untrusted"` for anything it cannot place — including a URL that
 * does not parse, since a field mid-typing must never flip the answer to
 * "trusted" and leave it there once the user finishes.
 */
export function guessEndpointTrust(baseUrl: string): AiEndpointTrust {
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return "untrusted";
  }
  if (!host) return "untrusted";
  // `new URL` strips the brackets from an IPv6 literal, so `::1` arrives bare.
  const bare = host.replace(/^\[|\]$/g, "");
  if (isLoopback(bare) || isPrivateV4(bare) || isLocalName(bare)) {
    return "trusted";
  }
  return "untrusted";
}
