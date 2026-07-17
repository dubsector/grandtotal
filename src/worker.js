const MIN_CENTS = 50; // Stripe's minimum charge in USD
const MAX_CENTS = 99999999; // Stripe caps amounts at 8 digits
// Digits, function names, and the operator glyphs the keypad emits
const EXPRESSION_RE = /^[0-9a-zA-Z+\-−×÷*\/^!(),.\s√π%]{1,120}$/;

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
    return env.ASSETS.fetch(request);
  },
};

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
  return json({ url: session.url });
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
