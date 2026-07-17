"use strict";

const MIN_CENTS = 50;
const MAX_CENTS = 99999999;
const STORE_KEY = "grandtotal.pending";
const ANS_KEY = "grandtotal.ans";
// Everything the keypad or a keyboard can reasonably produce; checked before billing
const EXPRESSION_RE = /^[0-9a-zA-Z+\-−×÷*\/^!(),.\s√π%]{1,120}$/;

const displayEl = document.getElementById("display");
const tapeEl = document.getElementById("tape");
const statusEl = document.getElementById("status");
const keysEl = document.getElementById("keys");

let busy = false;

function setStatus(msg, kind) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle("busy", value);
  displayEl.readOnly = value;
}

function fitDisplay() {
  const len = displayEl.value.length;
  displayEl.classList.toggle("small", len > 12);
  displayEl.classList.toggle("tiny", len > 24);
}

function flashError(msg) {
  setStatus(msg, "error");
  const screen = displayEl.closest(".screen");
  screen.classList.remove("shake");
  void screen.offsetWidth; // restart the animation
  screen.classList.add("shake");
}

function insertAtCaret(text) {
  const start = displayEl.selectionStart ?? displayEl.value.length;
  const end = displayEl.selectionEnd ?? displayEl.value.length;
  const next = displayEl.value.slice(0, start) + text + displayEl.value.slice(end);
  if (next.length > displayEl.maxLength) return;
  displayEl.value = next;
  const pos = start + text.length;
  displayEl.setSelectionRange(pos, pos);
  setStatus("");
  fitDisplay();
}

function backspaceAtCaret() {
  const start = displayEl.selectionStart ?? displayEl.value.length;
  const end = displayEl.selectionEnd ?? displayEl.value.length;
  const from = start === end ? Math.max(0, start - 1) : start;
  displayEl.value = displayEl.value.slice(0, from) + displayEl.value.slice(end);
  displayEl.setSelectionRange(from, from);
  setStatus("");
  fitDisplay();
}

function clearAll() {
  displayEl.value = "";
  setStatus("");
  sessionStorage.removeItem(STORE_KEY);
  fitDisplay();
}

// The display keeps the pretty glyphs; math.js gets plain syntax
function translate(expr) {
  return expr
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/√/g, "sqrt")
    .replace(/π/g, "pi")
    .replace(/\blog\(/g, "log10(")
    .replace(/\bln\(/g, "log(");
}

async function equals() {
  const raw = displayEl.value.trim();
  if (!raw) return;
  if (!EXPRESSION_RE.test(raw)) {
    return flashError("That is not billable math.");
  }

  let result;
  try {
    result = math.evaluate(translate(raw), {});
  } catch {
    return flashError("Syntax error. No charge.");
  }

  if (math.isComplex && math.isComplex(result)) {
    return flashError("Imaginary answers are unpayable.");
  }
  if (typeof result !== "number" || !Number.isFinite(result)) {
    return flashError("This answer is unpayable.");
  }

  const cents = Math.round(result * 100);
  if (cents <= 0) {
    return flashError("This answer is unpayable.");
  }
  if (cents < MIN_CENTS) {
    return flashError("Below the minimum billable answer ($0.50).");
  }
  if (cents > MAX_CENTS) {
    return flashError("Answer exceeds your credit limit.");
  }

  sessionStorage.setItem(STORE_KEY, JSON.stringify({ expression: raw }));

  setBusy(true);
  setStatus("Connecting to cashier…");
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_cents: cents, expression: raw }),
    });
    const data = await res.json();
    if (!res.ok || !data.url) {
      throw new Error(data.error || "Cashier unreachable. Answer withheld.");
    }
    if (Number.isInteger(data.count)) renderCount(data.count);
    window.location.href = data.url;
  } catch (err) {
    setBusy(false);
    flashError(err instanceof Error && err.message ? err.message : "Cashier unreachable. Answer withheld.");
  }
}

function recallAns() {
  const ans = localStorage.getItem(ANS_KEY);
  if (!ans) {
    return flashError("You do not own any answers yet.");
  }
  insertAtCaret(ans);
}

function readStore() {
  try {
    const data = JSON.parse(sessionStorage.getItem(STORE_KEY));
    return data && typeof data.expression === "string" ? data : null;
  } catch {
    return null;
  }
}

async function handleReturn() {
  const params = new URLSearchParams(location.search);
  if (params.has("session_id")) {
    history.replaceState(null, "", "/");
    const stored = readStore();
    setStatus("Verifying payment…");
    try {
      const res = await fetch("/api/session?id=" + encodeURIComponent(params.get("session_id")));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not verify payment.");
      if (data.payment_status === "paid" && Number.isInteger(data.amount_total)) {
        const amount = (data.amount_total / 100).toFixed(2);
        displayEl.value = amount;
        localStorage.setItem(ANS_KEY, amount);
        sessionStorage.removeItem(STORE_KEY);
        tapeEl.textContent = (stored ? stored.expression + " = " + amount : "= " + amount) + " · PAID";
        setStatus("Payment received. You own this answer now.", "paid");
      } else {
        if (stored) displayEl.value = stored.expression;
        setStatus("Payment incomplete. Answer withheld.", "error");
      }
    } catch (err) {
      if (stored) displayEl.value = stored.expression;
      setStatus(err instanceof Error && err.message ? err.message : "Could not verify payment.", "error");
    }
    fitDisplay();
  } else if (params.has("canceled")) {
    history.replaceState(null, "", "/");
    const stored = readStore();
    if (stored) displayEl.value = stored.expression;
    setStatus("Payment canceled. Answer withheld.", "error");
    fitDisplay();
  }
}

// Keep the caret in the display while tapping keypad buttons
keysEl.addEventListener("mousedown", (e) => e.preventDefault());

keysEl.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button || busy) return;
  if (button.dataset.insert !== undefined) insertAtCaret(button.dataset.insert);
  else if (button.dataset.action === "clear") clearAll();
  else if (button.dataset.action === "backspace") backspaceAtCaret();
  else if (button.dataset.action === "ans") recallAns();
  else if (button.dataset.action === "equals") equals();
});

displayEl.addEventListener("input", () => {
  setStatus("");
  fitDisplay();
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (busy) {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" || e.key === "=") {
    e.preventDefault();
    equals();
  } else if (e.key === "Escape") {
    e.preventDefault();
    clearAll();
  } else if (document.activeElement !== displayEl && /^[0-9a-z+\-*/^!(),.%]$/i.test(e.key)) {
    // Typing anywhere on the page lands in the display
    e.preventDefault();
    insertAtCaret(e.key);
  } else if (document.activeElement !== displayEl && e.key === "Backspace") {
    e.preventDefault();
    backspaceAtCaret();
  }
});

displayEl.focus();
handleReturn();
fitDisplay();

// Split-flap tally of every equation the cashier has billed
const flapsEl = document.getElementById("flaps");
const FLAP_DIGITS = 6;
const FLAP_MS = 150; // one half-turn; matches --flap-ms in the stylesheet
const COUNT_POLL_MS = 15000;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let flipGen = 0;

function makeFlap() {
  const flap = document.createElement("span");
  flap.className = "flap";
  for (const part of ["flap-top", "flap-bottom", "flap-leaf-front", "flap-leaf-back"]) {
    const half = document.createElement("span");
    half.className = "flap-half " + part;
    half.appendChild(document.createElement("span"));
    flap.appendChild(half);
  }
  flap.dataset.digit = "0";
  flap.children[0].firstChild.textContent = "0";
  flap.children[1].firstChild.textContent = "0";
  return flap;
}

function flapParts(flap) {
  return {
    top: flap.children[0].firstChild,
    bottom: flap.children[1].firstChild,
    front: flap.children[2].firstChild,
    back: flap.children[3].firstChild,
  };
}

// Snap an in-flight flip straight to its final face
function settleFlap(flap) {
  clearTimeout(flap._flapTimer);
  flap.classList.remove("flipping");
  const parts = flapParts(flap);
  parts.top.textContent = flap.dataset.digit;
  parts.bottom.textContent = flap.dataset.digit;
}

function flipFlap(flap, digit) {
  if (flap.dataset.digit === digit) return;
  settleFlap(flap);
  const old = flap.dataset.digit;
  flap.dataset.digit = digit;
  const parts = flapParts(flap);
  if (reducedMotion.matches) {
    parts.top.textContent = digit;
    parts.bottom.textContent = digit;
    return;
  }
  parts.top.textContent = digit; // revealed as the front leaf falls
  parts.bottom.textContent = old; // covered when the back leaf lands
  parts.front.textContent = old;
  parts.back.textContent = digit;
  void flap.offsetWidth; // restart the animation cleanly
  flap.classList.add("flipping");
  flap._flapTimer = setTimeout(() => settleFlap(flap), FLAP_MS * 2 + 40);
}

function renderCount(n) {
  if (!flapsEl || !Number.isInteger(n) || n < 0) return;
  const width = Math.max(FLAP_DIGITS, flapsEl.children.length, String(n).length);
  while (flapsEl.children.length < width) {
    flapsEl.insertBefore(makeFlap(), flapsEl.firstChild);
  }
  const digits = String(n).padStart(width, "0").split("");
  const gen = ++flipGen;
  let delay = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    const flap = flapsEl.children[i];
    const digit = digits[i];
    if (flap.dataset.digit === digit) continue;
    if (delay === 0 || reducedMotion.matches) {
      flipFlap(flap, digit);
    } else {
      setTimeout(() => {
        if (gen === flipGen) flipFlap(flap, digit);
      }, delay);
    }
    delay += 60; // cascade right to left like a departures board
  }
}

async function refreshCount() {
  try {
    const res = await fetch("/api/count");
    const data = await res.json();
    if (res.ok) renderCount(data.count);
  } catch {
    // The board keeps its last reading until the next poll
  }
}

if (flapsEl) {
  for (let i = 0; i < FLAP_DIGITS; i++) flapsEl.appendChild(makeFlap());
  refreshCount();
  setInterval(() => {
    if (!document.hidden) refreshCount();
  }, COUNT_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCount();
  });
}
