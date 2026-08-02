"use strict";

// Matomo tracking, loaded through the Worker's first-party proxy paths (see
// src/worker.js). Everything here is a no-op unless /api/analytics reports a
// configured site, so local dev and any deploy without the vars set stay
// silent.
(function () {
  const SCRIPT_URL = "/mtm/mtm.js";
  const TRACKER_URL = "/mtm/mtm.php";

  // Secrets live on the Worker rather than on a single version, so preview
  // deploys inherit them and would otherwise log branch traffic as real
  // grandtot.al visits. Only the production hostname tracks.
  const PRODUCTION_HOST = "grandtot.al";

  let enabled = false;
  // Whether /api/analytics has answered yet. The return trip from Stripe is
  // handled on page load, so those events are raised before the config
  // arrives - they wait here rather than being dropped.
  let pending = [];

  function paq() {
    window._paq = window._paq || [];
    return window._paq;
  }

  // Category/action/name/value, with the name trimmed to something Matomo
  // will actually store. Called from calc.js.
  window.gtTrack = function (action, name, value) {
    if (!pending && !enabled) return;
    const label = String(name == null ? "" : name).trim();
    const event = ["trackEvent", "calculator", action, label.slice(0, 100)];
    if (typeof value === "number" && Number.isFinite(value)) event.push(value);
    if (enabled) paq().push(event);
    else if (pending.length < 20) pending.push(event);
  };

  function stopTracking() {
    pending = null;
  }

  function startTracking(siteId) {
    const q = paq();
    // Cookieless keeps the site out of consent-banner territory: with no
    // cookies, anonymized IPs and a self-hosted install, Matomo qualifies for
    // the CNIL-style consent exemption. The cost is that returning visitors
    // stop being identifiable past the ~24h config-id window, which is close
    // to meaningless on a one-page calculator.
    q.push(["disableCookies"]);
    q.push(["setDoNotTrack", true]);
    // The billed event fires immediately before the redirect to Stripe, so it
    // has to survive the page going away. sendBeacon is Matomo's default in
    // 5.x, but that event is half the point of tracking this at all.
    q.push(["alwaysUseSendBeacon"]);
    q.push(["setTrackerUrl", TRACKER_URL]);
    q.push(["setSiteId", siteId]);
    q.push(["trackPageView"]);
    q.push(["enableLinkTracking"]);

    const script = document.createElement("script");
    script.async = true;
    script.src = SCRIPT_URL;
    document.head.appendChild(script);

    enabled = true;
    for (const event of pending) q.push(event);
    pending = null;
  }

  if (window.location.hostname !== PRODUCTION_HOST) return stopTracking();

  fetch("/api/analytics")
    .then((res) => (res.status === 200 ? res.json() : null))
    .then((config) => {
      if (config && config.siteId) startTracking(config.siteId);
      else stopTracking();
    })
    .catch(() => {
      // Analytics is never worth breaking the calculator over.
      stopTracking();
    });
})();
