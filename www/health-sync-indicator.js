/**
 * Délègue au bandeau natif (BridgeViewController) s'il est chargé — sinon fallback minimal.
 */
(function (global) {
  function isBackfillActive() {
    if (global.__pcpHealthBackfillRunning === true) return true;
    try {
      const storage = global.PcpHealthSyncStorage;
      if (storage?.isFullBackfillComplete?.()) return false;
      if (typeof storage?.isBackfillPending === "function" && storage.isBackfillPending()) {
        return true;
      }
    } catch (_) {}
    try {
      const b = global.PcpHealthBridge;
      if (b?.isBackfillRunning?.()) return true;
      if (b?.isBackfillPending?.()) return true;
    } catch (_) {}
    return false;
  }

  function showBanner() {
    if (typeof global.showBackfillBanner === "function") {
      global.showBackfillBanner();
      return;
    }
  }

  function hideBanner() {
    if (typeof global.hideBackfillBanner === "function") {
      global.hideBackfillBanner(false);
    }
  }

  function syncBannerState() {
    if (typeof global.syncBackfillBanner === "function") {
      global.syncBackfillBanner();
      return;
    }
    if (isBackfillActive()) showBanner();
    else hideBanner();
  }

  global.addEventListener("pcp-health-backfill-started", () => syncBannerState());
  global.addEventListener("pcp-health-backfill-finished", (ev) => {
    if (ev?.detail?.ok === false) return;
    global.__pcpHealthBackfillRunning = false;
    syncBannerState();
  });
  global.addEventListener("pcp-health-sync-finished", () => syncBannerState());

  global.PcpHealthSyncIndicator = {
    show: showBanner,
    hide: hideBanner,
    sync: syncBannerState,
    isActive: isBackfillActive,
  };

  global.setTimeout(syncBannerState, 800);
})();
