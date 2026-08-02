import { DurableObject } from "cloudflare:workers";

const MIN_CENTS = 50; // Stripe's minimum charge in USD
const MAX_CENTS = 99999999; // Stripe caps amounts at 8 digits
// Digits, function names, and the operator glyphs the keypad emits
const EXPRESSION_RE = /^[0-9a-zA-Z+\-−×÷*\/^!(),.\s√π%]{1,120}$/;

// Matomo is proxied through this Worker rather than loaded straight off the
// Matomo host: the browser only ever talks to grandtot.al, so the tracker
// isn't a third-party request (no adblock/tracker-list hit), the self-hosted
// Matomo hostname stays private, and the visitor's real IP still reaches
// Matomo via X-Visitor-IP.
const MATOMO_SCRIPT_PATH = "/mtm/mtm.js";
const MATOMO_TRACK_PATH = "/mtm/mtm.php";

// Single global tally of calculations sold, kept in one Durable Object
export class Counter extends DurableObject {
  async increment() {
    const n = ((await this.ctx.storage.get("count")) || 0) + 1;
    await this.ctx.storage.put("count", n);
    return n;
  }

  async value() {
    return (await this.ctx.storage.get("count")) || 0;
  }
}

function counter(env) {
  return env.COUNTER.get(env.COUNTER.idFromName("global"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      return createCheckout(request, env, url);
    }
    if (url.pathname === "/api/session") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return getSession(url, env);
    }
    if (url.pathname === "/api/count") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return new Response(JSON.stringify({ count: await counter(env).value() }), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }
    // The client asks whether analytics is configured before loading
    // anything, so local dev and any deploy without the vars set simply run
    // with tracking off instead of firing requests into a 503.
    if (url.pathname === "/api/analytics") {
      const siteId = env.MATOMO_SITE_ID;
      if (!siteId || !env.MATOMO_ORIGIN) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ siteId: String(siteId) }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (url.pathname === MATOMO_SCRIPT_PATH) {
      return proxyToMatomo(request, env, "/matomo.js");
    }
    if (url.pathname === MATOMO_TRACK_PATH) {
      return proxyToMatomo(request, env, "/matomo.php");
    }
    return env.ASSETS.fetch(request);
  },
};

async function proxyToMatomo(request, env, upstreamPath) {
  const origin = env.MATOMO_ORIGIN;
  if (!origin) return new Response("Analytics not configured", { status: 503 });

  const url = new URL(request.url);
  const upstream = new URL(upstreamPath, origin);
  upstream.search = url.search;

  const headers = new Headers();
  for (const name of ["user-agent", "accept", "accept-language", "content-type", "referer"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // The visitor IP rides in a custom header rather than X-Forwarded-For.
  // This subrequest goes back out through Cloudflare's edge to reach the
  // tunnel in front of Matomo, and the edge rewrites X-Forwarded-For to the
  // connecting IP of that leg - so anything we put there is gone by the time
  // Matomo reads it, and every visit gets logged as the tunnel. A header
  // Cloudflare doesn't manage survives the trip intact. Matomo reads it via
  // proxy_client_headers[] = HTTP_X_VISITOR_IP.
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers.set("X-Visitor-IP", ip);

  const response = await fetch(upstream, {
    method: request.method,
    headers,
    body: request.method === "POST" ? request.body : undefined,
  });

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function createCheckout(request, env, url) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Cashier not configured (missing Stripe key)." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  const cents = body.amount_cents;
  const expression = typeof body.expression === "string" ? body.expression.trim() : "";
  if (!Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS) {
    return json({ error: "Unbillable amount." }, 400);
  }
  if (!EXPRESSION_RE.test(expression)) {
    return json({ error: "Unbillable equation." }, 400);
  }

  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": `${expression} =`,
    success_url: `${url.origin}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/?canceled=1`,
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const session = await res.json();
  if (!res.ok || !session.url) {
    return json({ error: "The cashier rejected this equation." }, 502);
  }

  // The tally only moves when the cashier actually prices an equation
  let count = null;
  try {
    count = await counter(env).increment();
  } catch {
    // A stuck tally should never block a sale
  }
  return json({ url: session.url, count });
}

async function getSession(url, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Cashier not configured (missing Stripe key)." }, 500);
  }

  const id = url.searchParams.get("id") || "";
  if (!/^cs_[a-zA-Z0-9_]{1,250}$/.test(id)) {
    return json({ error: "Bad session id." }, 400);
  }

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  const session = await res.json();
  if (!res.ok) {
    return json({ error: "Unknown session." }, 404);
  }
  return json({
    amount_total: session.amount_total,
    payment_status: session.payment_status,
  });
}
