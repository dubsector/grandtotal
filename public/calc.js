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
