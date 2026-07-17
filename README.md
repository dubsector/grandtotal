# Grand Total

A scientific calculator that charges you for the answer.

Type `1.25 + 1.25` and press `=`. Instead of showing the result, it opens a Stripe Checkout for exactly $2.50. The line item is your equation and the price is the answer. Pay up and you get sent back to the calculator with the result on the display, marked as paid in full.

It handles real math, not just arithmetic: `sqrt(2)*(3+1)^2` will bill you $22.63. Trig, logs, factorials, parentheses, powers and constants all work, courtesy of [math.js](https://mathjs.org/). The ANS key recalls the last answer you actually paid for. You own that number.

Runs in Stripe test mode, so no real money moves. Use test card 4242 4242 4242 4242 with any future expiry and any CVC.

## Rules of the house

* Answers under $0.50 are below the minimum billable amount (Stripe's floor)
* Zero, negative, imaginary and undefined answers are unpayable
* Answers over $999,999.99 exceed your credit limit
* Fractional cents are rounded to the nearest cent
* Canceling checkout means the answer is withheld

## Stack

Cloudflare Worker with static assets. Plain HTML/CSS/JS frontend with math.js vendored in `public/vendor/`, one Worker (`src/worker.js`) with three routes:

* `POST /api/checkout` creates a Stripe Checkout Session for the computed total
* `GET /api/session` verifies payment status when you land back on the calculator
* `GET /api/count` reports how many equations the cashier has billed so far

No frameworks, no build step, no Stripe SDK. The Worker talks to the Stripe REST API with plain fetch.

The running tally lives in a single SQLite-backed Durable Object (`Counter` in `src/worker.js`). It increments once per checkout session created, and the footer shows it on a split-flap board that polls every 15 seconds.

After a mathjs version bump, run `npm run vendor` to refresh the copy in `public/vendor/`.

## Brand palette

Stripe Checkout branding (Settings > Business > Branding, per environment) uses the app colors:

* Background: `#101014` (page), `#1a1a20` (calculator card)
* Accent / Pay button: `#0f9d58` (the equals key)
* Operator amber: `#e8930c`, paid green: `#35d07f`
* Icon: `stripe-icon.png` at the repo root (512x512, made for the circular crop)

## Run locally

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and paste your Stripe test secret key
3. `npm run dev` and open http://localhost:8787

## Deploy

`npx wrangler deploy`, then set the secret once:

```
npx wrangler secret put STRIPE_SECRET_KEY
```
