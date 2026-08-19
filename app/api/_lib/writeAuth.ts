// Authorisation gate for the mutating capture endpoints.
//
// THREAT MODEL. This is a single-user app with no user accounts, normally
// reached only over a private Tailscale tailnet — so for its intended
// deployment the network *is* the authorisation boundary and no check is
// needed. That assumption breaks the moment the app is reached any other way
// (an HTTPS tunnel for field-testing on a phone, a LAN bind, a future public
// host), because these routes create and DELETE capture records with no notion
// of an owner: possession of a capture id is otherwise the entire authorisation
// decision.
//
// So: set PLAQUE_KEY and every mutating request must present it as
// `X-Plaque-Key`. Reads stay open — they expose only public plaque data.
//
// Deliberately enforce-when-set rather than always-required: an unset key keeps
// `npm run dev` and the test suite frictionless, which is the behaviour that
// matches the tailnet-only default. The tradeoff is that forgetting to set it
// fails *open*, so the startup warning below is not decorative — it is the
// control that makes the omission visible.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

let warned = false;

/** Constant-time compare; avoids leaking the key a character at a time. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Returns `null` when the request may proceed, or a 401 response to return.
 *
 *   const denied = requireWriteAuth(req);
 *   if (denied) return denied;
 */
export function requireWriteAuth(req: Request): NextResponse | null {
  const expected = process.env.PLAQUE_KEY;

  if (!expected) {
    if (!warned && process.env.NODE_ENV === "production") {
      warned = true;
      console.warn(
        "[writeAuth] PLAQUE_KEY is not set — capture create/confirm/delete are " +
          "UNAUTHENTICATED. Safe only if this app is reachable solely from a " +
          "trusted network. Set PLAQUE_KEY before exposing it any other way.",
      );
    }
    return null;
  }

  const provided = req.headers.get("x-plaque-key");
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
