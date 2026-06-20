/**
 * Après sync santé : invalide le cache React Query (anneaux + vitals + activités)
 * et refetch — sans modifier le frontend Next.js.
 */
(function (global) {
  const HEALTH_QUERY_PREFIXES = [
    ["health"],
    ["health", "me", "daily"],
    ["health", "me", "vitals-latest"],
    ["health", "me", "workouts-unvalidated"],
  ];

  const LAST_DATA_SYNC_KEY = "pcpHealthLastDataSyncAt";
  /** Délais après fin de sync (pas pendant) — le backend recalcule les anneaux. */
  const REFRESH_RETRY_MS = [1000, 3000, 6000];

  let refreshChain = Promise.resolve();
  let routeHookInstalled = false;

  function log(msg) {
    try {
      const line = `[Refresh] ${String(msg)}`;
      console.log("[PcpHealthRefresh]", line);
      if (window.PcpHealthLogExport?.push) {
        window.PcpHealthLogExport.push(line);
      }
      if (
        window.webkit &&
        window.webkit.messageHandlers &&
        window.webkit.messageHandlers.pcpHealthLog
      ) {
        window.webkit.messageHandlers.pcpHealthLog.postMessage(line);
      }
    } catch (_) {}
  }

  function isQueryClient(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.invalidateQueries === "function" &&
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

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function invalidateHealthQueries(queryClient) {
    const client = queryClient || (await waitForQueryClient(5000));
    if (!client) {
      log("invalidate: QueryClient introuvable");
      return false;
    }

    try {
      const tasks = [];
      for (const queryKey of HEALTH_QUERY_PREFIXES) {
        tasks.push(
          client.invalidateQueries({
            queryKey,
            refetchType: "all",
          }),
        );
      }
      await Promise.all(tasks);

      const refetchTasks = [];
      for (const queryKey of HEALTH_QUERY_PREFIXES) {
        refetchTasks.push(
          client.refetchQueries({
            queryKey,
            type: "all",
          }),
        );
      }
      await Promise.all(refetchTasks);
      log("invalidate: cache santé (anneaux + vitals) invalidé + refetch all");
      return true;
    } catch (err) {
      log(`invalidate: erreur ${err && err.message ? err.message : err}`);
      return false;
    }
  }

  function ensureRefreshStyles() {
    if (document.getElementById("pcp-health-refresh-style")) return;
    const style = document.createElement("style");
    style.id = "pcp-health-refresh-style";
    style.textContent =
      "@keyframes pcpHealthRingPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.72;transform:scale(.985)}}" +
      ".pcp-health-section-refresh{animation:pcpHealthRingPulse .55s ease-in-out}";
    document.head.appendChild(style);
  }

  function findHealthSection() {
    const sections = document.querySelectorAll("main section");
    for (const section of sections) {
      if (section.querySelector("div.overflow-x-auto svg")) {
        return section;
      }
    }
    const row =
      document.querySelector("main [data-no-swipe-sync]") ||
      document.querySelector("main div.overflow-x-auto");
    return row?.closest("section") ?? sections[0] ?? null;
  }

  function pulseIfHome() {
    if (!/\/patient\/home/.test(window.location.pathname || "")) return false;
    const section = findHealthSection();
    if (!section) return false;

    ensureRefreshStyles();
    section.classList.remove("pcp-health-section-refresh");
    void section.offsetWidth;
    section.classList.add("pcp-health-section-refresh");
    window.setTimeout(() => {
      section.classList.remove("pcp-health-section-refresh");
    }, 600);
    return true;
  }

  function recentSyncWithin(ms) {
    try {
      const getter = global.PcpHealthSyncStorage?.getItem;
      const key = global.PcpHealthSyncStorage?.LAST_DATA_SYNC_KEY || LAST_DATA_SYNC_KEY;
      const last = parseInt((getter ? getter(key) : sessionStorage.getItem(LAST_DATA_SYNC_KEY)) || "0", 10);
      return last > 0 && Date.now() - last < ms;
    } catch (_) {
      return false;
    }
  }

  /**
   * Refetch santé après sync (manuelle, auto, backfill).
   * Plusieurs tentatives : le backend peut mettre quelques secondes à exposer vitals/latest.
   */
  /** Sync visible utilisateur (pas le backfill historique en arrière-plan). */
  function isForegroundSyncActive() {
    return !!(window.__pcpHealthSyncRunning || window.__pcpManualSyncLock);
  }

  async function refreshAfterSync(options) {
    const reason = options?.reason || "sync";
    const retries = Array.isArray(options?.retryMs) ? options.retryMs : REFRESH_RETRY_MS;

    if (isForegroundSyncActive()) {
      log(`refreshAfterSync(${reason}) ignoré — sync encore active`);
      return { invalidated: false, reason, skipped: true };
    }

    let lastOk = false;
    let queryClient = null;

    for (let i = 0; i < retries.length; i++) {
      if (isForegroundSyncActive()) {
        log(`refreshAfterSync(${reason}) interrompu — sync relancée`);
        return { invalidated: false, reason, skipped: true };
      }
      if (i === 0) {
        await sleep(retries[0]);
      } else {
        await sleep(retries[i] - retries[i - 1]);
      }
      if (!queryClient) {
        queryClient = await waitForQueryClient(5000);
      }
      lastOk = await invalidateHealthQueries(queryClient);
      log(`refreshAfterSync(${reason}) tentative ${i + 1}/${retries.length} ok=${lastOk}`);
    }

    try {
      global.dispatchEvent(
        new CustomEvent("pcp-health-queries-invalidated", {
          detail: { ok: lastOk, reason },
        }),
      );
    } catch (_) {}

    // Overlay HC après refetch — évite que vitals/latest backend (valeurs aberrantes)
    // n'écrase les lectures HC plausibles déjà patchées.
    if (lastOk && global.PcpHealthConnectDisplay?.applyOverlay) {
      try {
        await global.PcpHealthConnectDisplay.applyOverlay();
      } catch (_) {}
    }

    return { invalidated: lastOk, reason };
  }

  function scheduleRefreshAfterSync(options) {
    refreshChain = refreshChain
      .then(() => refreshAfterSync(options))
      .catch((err) => {
        log(`scheduleRefresh: ${err && err.message ? err.message : err}`);
        return { invalidated: false };
      });
    return refreshChain;
  }

  function installRouteRefreshHook() {
    if (routeHookInstalled) return;
    routeHookInstalled = true;

    let lastPath = "";
    function onRouteChange() {
      const path = window.location.pathname || "";
      if (path === lastPath) return;
      lastPath = path;
      if (!/\/patient\/(home|health)/.test(path)) return;
      if (isForegroundSyncActive()) return;
      if (!recentSyncWithin(10 * 60 * 1000)) return;
      log("navigation accueil après sync récente — refetch santé");
      scheduleRefreshAfterSync({ reason: "route-home", retryMs: [300, 2000] });
    }

    window.addEventListener("popstate", onRouteChange);
    window.setInterval(onRouteChange, 800);
  }

  function installSyncListeners() {
    if (global.__pcpHealthRefreshListeners) return;
    global.__pcpHealthRefreshListeners = true;

    window.addEventListener("pcp-health-sync-finished", (ev) => {
      const d = ev?.detail || {};
      if (d.skipped || d.empty) return;
      if (d.ok !== true) return;
      if (d.readyForUiRefresh === false) return;
      if (window.__pcpHealthBackfillRunning) return;
      const reason = d.manual ? "sync-manual" : "sync-auto";
      window.setTimeout(() => {
        if (isForegroundSyncActive() || window.__pcpHealthBackfillRunning) {
          log(`refresh(${reason}) reporté — sync/backfill encore actif`);
          return;
        }
        scheduleRefreshAfterSync({ reason });
      }, 120);
    });

    window.addEventListener("pcp-health-backfill-finished", (ev) => {
      const d = ev?.detail || {};
      if (d.ok !== true) return;
      window.setTimeout(() => {
        if (isForegroundSyncActive()) {
          log("refresh(backfill-complete) reporté — sync premier plan actif");
          return;
        }
        scheduleRefreshAfterSync({
          reason: "backfill-complete",
          pulse: true,
          retryMs: [1000, 3000, 6000],
        });
      }, 200);
    });

    installRouteRefreshHook();
  }

  installSyncListeners();

  /** @deprecated Utiliser refreshAfterSync */
  async function refreshAfterManualSync(_token) {
    return refreshAfterSync({ reason: "sync-manual-legacy" });
  }

  global.PcpHealthDisplayRefresh = {
    pulse: pulseIfHome,
    invalidateHealthQueries,
    refreshAfterSync,
    scheduleRefreshAfterSync,
    refreshAfterManualSync,
  };
})(typeof window !== "undefined" ? window : globalThis);
