/**
 * Android : après sync, lit Health Connect et patche le cache React Query
 * (daily + vitals-latest) pour que le frontend affiche les valeurs HC.
 * Pas d'UI injectée — la section Santé est gérée par le frontend.
 */
(function (global) {
  const DAILY_KEY_PREFIX = ["health", "me", "daily"];
  const VITALS_KEY = ["health", "me", "vitals-latest"];

  function log(msg) {
    try {
      const line = `[HC-display] ${String(msg)}`;
      console.log("[PcpHealthDisplay]", line);
      if (window.PcpHealthLogExport?.push) {
        window.PcpHealthLogExport.push(line);
      }
    } catch (_) {}
  }

  function isQueryClient(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.setQueryData === "function" &&
      typeof value.getQueryCache === "function"
    );
  }

  function findQueryClientFromFiber() {
    const roots = [
      document.getElementById("__next"),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    for (const root of roots) {
      const fiberKey = Object.keys(root).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactContainer$"),
      );
      if (!fiberKey) continue;

      const queue = [root[fiberKey]];
      const seen = new Set();
      while (queue.length) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);

        const propsClient = fiber.memoizedProps && fiber.memoizedProps.client;
        if (isQueryClient(propsClient)) return propsClient;

        const pendingClient = fiber.pendingProps && fiber.pendingProps.client;
        if (isQueryClient(pendingClient)) return pendingClient;

        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
    }
    return null;
  }

  function waitForQueryClient(maxMs) {
    const deadline = Date.now() + (maxMs || 5000);
    return new Promise((resolve) => {
      function attempt() {
        const client = findQueryClientFromFiber();
        if (client) {
          resolve(client);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        window.setTimeout(attempt, 120);
      }
      attempt();
    });
  }

  function numStr(value) {
    if (value == null || value === "") return null;
    return String(value);
  }

  function readSnapshot() {
    const bridge = global.PcpHealthBridge;
    if (!bridge || typeof bridge.getHealthConnectDisplaySnapshot !== "function") {
      return null;
    }
    try {
      const raw = bridge.getHealthConnectDisplaySnapshot();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.error) {
        log(`snapshot erreur: ${parsed.error}`);
        return null;
      }
      return parsed;
    } catch (err) {
      log(`snapshot parse: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  function minimalDailyStub(dayStr) {
    return {
      id: "hc-overlay-" + dayStr,
      patient_id: "",
      day: dayStr,
      recovery_score: null,
      sleep_score: null,
      stress_score: null,
      effort_score: null,
      steps_total: null,
      distance_total_m: null,
      calories_total_kcal: null,
      sleep_total_min: null,
      mindfulness_total_min: null,
      resting_heart_rate_avg: null,
      hrv_avg_ms: null,
      respiratory_rate_avg: null,
      oxygen_saturation_avg: null,
      body_temperature_avg: null,
      primary_source: "health_connect",
      extra: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  const HC_DAILY_VITAL_FIELDS = [
    "hrv_avg_ms",
    "resting_heart_rate_avg",
    "respiratory_rate_avg",
    "oxygen_saturation_avg",
    "body_temperature_avg",
  ];

  function patchDailyRow(existing, today, dayStr) {
    const base = existing && typeof existing === "object" ? { ...existing } : minimalDailyStub(dayStr);
    if (!base.day) base.day = dayStr;
    if (today.steps_total != null) base.steps_total = Math.round(Number(today.steps_total));
    if (today.calories_total_kcal != null) {
      base.calories_total_kcal = numStr(today.calories_total_kcal);
    }
    if (today.sleep_total_min != null) {
      base.sleep_total_min = Math.round(Number(today.sleep_total_min));
    }
    HC_DAILY_VITAL_FIELDS.forEach((field) => {
      const raw = today[field];
      base[field] = raw != null ? numStr(raw) : null;
    });
    base.primary_source = "health_connect";
    return base;
  }

  function patchVitals(_existing, vitals) {
    const base = {};
    const map = {
      hrv: "hrv",
      resting_heart_rate: "resting_heart_rate",
      respiratory_rate: "respiratory_rate",
      oxygen_saturation: "oxygen_saturation",
      body_temperature: "body_temperature",
    };
    Object.keys(map).forEach((src) => {
      const block = vitals[src];
      if (!block || block.value == null) return;
      base[src] = {
        data_type: block.data_type || src,
        value: numStr(block.value),
        unit: block.unit || null,
        recorded_at: block.recorded_at || null,
        source_name: block.source_name || "health_connect",
      };
    });
    return base;
  }

  function listDailyQueries(cache) {
    return cache.findAll({ queryKey: DAILY_KEY_PREFIX }).map((q) => q.queryKey);
  }

  function removeLegacyVitalsStrip() {
    const el = document.getElementById("pcp-android-vitals-strip");
    if (el) el.remove();
  }

  async function applyHealthConnectOverlay() {
    if (!/android/i.test(navigator.userAgent || "")) return false;
    const snapshot = readSnapshot();
    if (!snapshot || !snapshot.today) return false;

    const client = await waitForQueryClient(5000);
    if (!client) {
      log("QueryClient introuvable");
      return false;
    }

    const dayStr = snapshot.day || snapshot.today.day;
    const today = snapshot.today;
    const vitals = snapshot.vitals || {};
    const cache = client.getQueryCache();
    const dailyKeys = listDailyQueries(cache);

    let patched = false;
    const keysToPatch = dailyKeys.length > 0 ? dailyKeys : [[...DAILY_KEY_PREFIX, 1]];

    for (const queryKey of keysToPatch) {
      const prev = client.getQueryData(queryKey);
      const next = Array.isArray(prev) ? prev.slice() : [];
      const idx = next.findIndex((row) => row && row.day === dayStr);
      const row = patchDailyRow(idx >= 0 ? next[idx] : minimalDailyStub(dayStr), today, dayStr);
      if (idx >= 0) {
        next[idx] = row;
      } else {
        next.unshift(row);
      }
      client.setQueryData(queryKey, next);
      patched = true;
    }

    const prevVitals = client.getQueryData(VITALS_KEY);
    const nextVitals = patchVitals(prevVitals, vitals);
    client.setQueryData(VITALS_KEY, nextVitals);
    patched = true;

    if (patched) {
      const v = nextVitals || {};
      log(
        `cache patché jour=${dayStr} sommeil=${today.sleep_total_min ?? "—"} ` +
          `hrv=${today.hrv_avg_ms ?? v.hrv?.value ?? "—"} ` +
          `resp=${today.respiratory_rate_avg ?? v.respiratory_rate?.value ?? "—"} ` +
          `spo2=${today.oxygen_saturation_avg ?? v.oxygen_saturation?.value ?? "—"} ` +
          `temp=${today.body_temperature_avg ?? v.body_temperature?.value ?? "—"}`,
      );
    }
    return patched;
  }

  function installListeners() {
    if (global.__pcpHcDisplaySyncInstalled) return;
    global.__pcpHcDisplaySyncInstalled = true;

    removeLegacyVitalsStrip();

    let lastPath = "";
    function isPatientHealthRoute(path) {
      return /\/patient\/(home|health)/.test(path || "");
    }

    function onRoute() {
      const path = window.location.pathname || "";
      if (path === lastPath) return;
      lastPath = path;
      removeLegacyVitalsStrip();
      if (!isPatientHealthRoute(path)) return;
      window.setTimeout(() => {
        applyHealthConnectOverlay().catch(() => {});
      }, 600);
    }
    window.addEventListener("popstate", onRoute);
    window.setInterval(onRoute, 1000);

    window.addEventListener("pcp-health-queries-invalidated", function () {
      window.setTimeout(function () {
        applyHealthConnectOverlay().catch(function () {});
      }, 200);
    });

    window.addEventListener("pcp-health-sync-finished", function (ev) {
      var d = (ev && ev.detail) || {};
      if (d.ok !== true || d.skipped) return;
      window.setTimeout(function () {
        applyHealthConnectOverlay().catch(function () {});
      }, 400);
    });
  }

  installListeners();

  global.PcpHealthConnectDisplay = {
    applyOverlay: applyHealthConnectOverlay,
    readSnapshot,
  };
})(typeof window !== "undefined" ? window : globalThis);
