/**
 * État sync scopé par patient — parité iOS PcpHealthSyncStorage (Android natif).
 */
(function () {
  if (window.PcpHealthSyncStorage) return;

  var FULL_BACKFILL_KEY = "pcpHealthFullBackfillAt";
  var BACKFILL_PENDING_KEY = "pcpHealthBackfillPending";
  var HISTORICAL_CHECKPOINT_KEY = "pcpHealthHistoricalCheckpoint";
  var LAST_DATA_SYNC_KEY = "pcpHealthLastDataSyncAt";
  var STEPS_REPAIR_KEY = "pcpHealthStepsRepairV2";
  var SLEEP_STAGES_REPAIR_KEY = "pcpHealthSleepStagesRepairV2";
  var SLEEP_STAGES_REPAIR_ATTEMPTS_KEY = "pcpHealthSleepStagesRepairAttemptsV2";
  var SCORING_90D_REPAIR_KEY = "pcpHealthScoring90dRepairV1";
  var RECOVERY_RESCORE_REPAIR_KEY = "pcpHealthRecoveryRescoreRepairV4";
  var SYNC_SCOPE_PATIENT_KEY = "pcpHealthSyncScopePatientId";
  var NATIVE_PERSIST_KEYS = new Set([
    FULL_BACKFILL_KEY,
    LAST_DATA_SYNC_KEY,
    BACKFILL_PENDING_KEY,
    HISTORICAL_CHECKPOINT_KEY,
    STEPS_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_ATTEMPTS_KEY,
    SCORING_90D_REPAIR_KEY,
    RECOVERY_RESCORE_REPAIR_KEY,
  ]);
  var NATIVE_TS_KEYS = new Set([
    FULL_BACKFILL_KEY,
    LAST_DATA_SYNC_KEY,
    STEPS_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_ATTEMPTS_KEY,
    SCORING_90D_REPAIR_KEY,
    RECOVERY_RESCORE_REPAIR_KEY,
  ]);

  function log(msg) {
    try {
      console.log("[PcpHealth]", "[AndroidStorage] " + msg);
      if (window.PcpHealthLogExport && window.PcpHealthLogExport.push) {
        window.PcpHealthLogExport.push("[Android] " + msg);
      }
    } catch (e) {}
  }

  function patientIdFromAccessToken(token) {
    if (!token || typeof token !== "string") return "";
    try {
      var payload = token.split(".")[1];
      if (!payload) return "";
      var json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return typeof json.sub === "string" ? json.sub : "";
    } catch (e) {
      return "";
    }
  }

  function resolveSyncPatientId(token) {
    return (
      patientIdFromAccessToken(token) ||
      (typeof window.__pcpHealthSyncPatientId === "string" ? window.__pcpHealthSyncPatientId : "") ||
      ""
    );
  }

  function scopedSyncKey(baseKey, patientId) {
    var pid = patientId || resolveSyncPatientId("");
    return pid ? baseKey + ":" + pid : baseKey;
  }

  function bridge() {
    return window.PcpHealthBridge || null;
  }

  function persistSyncKeyToNative(baseKey, value, token) {
    var pid = resolveSyncPatientId(token);
    if (!pid || !NATIVE_PERSIST_KEYS.has(baseKey)) return;
    var b = bridge();
    if (!b || !b.setSyncScopedState) return;
    try {
      b.setSyncScopedState(pid, baseKey, value == null ? "" : String(value));
    } catch (e) {}
  }

  function getItem(baseKey, token) {
    return sessionStorage.getItem(scopedSyncKey(baseKey, resolveSyncPatientId(token)));
  }

  function setItem(baseKey, value, token) {
    var pid = resolveSyncPatientId(token);
    if (pid) {
      sessionStorage.setItem(SYNC_SCOPE_PATIENT_KEY, pid);
      window.__pcpHealthSyncPatientId = pid;
    }
    sessionStorage.setItem(scopedSyncKey(baseKey, pid), value);
    persistSyncKeyToNative(baseKey, value, token);
  }

  function ensureSyncPatientScope(token) {
    var pid = resolveSyncPatientId(token);
    if (!pid) return null;
    var prev = sessionStorage.getItem(SYNC_SCOPE_PATIENT_KEY);
    if (prev && prev !== pid) {
      log("Compte patient changé — backfill 90j intraday requis pour ce compte");
    }
    sessionStorage.setItem(SYNC_SCOPE_PATIENT_KEY, pid);
    window.__pcpHealthSyncPatientId = pid;
    return pid;
  }

  function isFullBackfillComplete(token) {
    return parseInt(getItem(FULL_BACKFILL_KEY, token) || "0", 10) > 0;
  }

  function isBackfillPending(token) {
    // Ne pas lire __pcpHealthBackfillRunning ici : le poll JS le pose à true et
    // bouclerait indéfiniment (pending toujours vrai → bandeau jamais masqué).
    var b = bridge();
    try {
      if (b && b.isBackfillRunning && b.isBackfillRunning()) return true;
      if (b && b.isBackfillPending && b.isBackfillPending()) return true;
    } catch (e) {}
    return getItem(BACKFILL_PENDING_KEY, token) === "1";
  }

  function setHistoricalBackfillPending(token, pending) {
    if (pending) {
      setItem(BACKFILL_PENDING_KEY, "1", token);
    } else {
      var pid = resolveSyncPatientId(token);
      try {
        sessionStorage.removeItem(scopedSyncKey(BACKFILL_PENDING_KEY, pid));
      } catch (e) {}
      persistSyncKeyToNative(BACKFILL_PENDING_KEY, "", token);
    }
  }

  function reconcileLocalBackfillState(token) {
    ensureSyncPatientScope(token);
    var fullAt = parseInt(getItem(FULL_BACKFILL_KEY, token) || "0", 10);
    var pending = getItem(BACKFILL_PENDING_KEY, token) === "1";
    if (fullAt > 0 && pending) {
      setHistoricalBackfillPending(token, false);
      log("État sync réconcilié — backfill terminé, pending obsolète effacé");
      try {
        window.__pcpHealthBackfillRunning = false;
        if (typeof window.syncBackfillBanner === "function") window.syncBackfillBanner();
      } catch (e) {}
      return { reconciled: true, reason: "stale_pending" };
    }
    var b = bridge();
    if (b && b.getFullBackfillAt) {
      var nativeFull = b.getFullBackfillAt();
      if (nativeFull > 0 && fullAt <= 0) {
        setItem(FULL_BACKFILL_KEY, String(nativeFull), token);
        fullAt = nativeFull;
      }
    }
    var skipMeta = null;
    try {
      var raw = sessionStorage.getItem("pcpHealthBackfillSkipMeta");
      if (raw) skipMeta = JSON.parse(raw);
    } catch (e) {}
    if (skipMeta && skipMeta.at && fullAt <= 0) {
      setItem(FULL_BACKFILL_KEY, String(skipMeta.at), token);
      setHistoricalBackfillPending(token, false);
      if (b && b.markServerBackfillComplete) {
        b.markServerBackfillComplete(skipMeta.at);
      }
      log(
        "État sync réconcilié depuis probe serveur (" +
          (skipMeta.daysWithData != null ? skipMeta.daysWithData : "?") +
          "j signal, span=" +
          (skipMeta.spanDays != null ? skipMeta.spanDays : "?") +
          ")",
      );
      return { reconciled: true, reason: "skip_meta" };
    }
    if (fullAt > 0 && !pending && b && b.isBackfillPending && b.isBackfillPending()) {
      setHistoricalBackfillPending(token, false);
    }
    return { reconciled: false };
  }

  async function hydrateFromNative(token) {
    var pid = resolveSyncPatientId(token);
    if (!pid) return { hydrated: false };
    var b = bridge();
    if (!b || !b.getSyncScopedState) return { hydrated: false };
    var native;
    try {
      native = JSON.parse(b.getSyncScopedState(pid) || "{}");
    } catch (e) {
      return { hydrated: false };
    }
    if (!native || typeof native !== "object") return { hydrated: false };
    var merged = 0;
    NATIVE_PERSIST_KEYS.forEach(function (baseKey) {
      var raw = native[baseKey];
      if (raw == null || raw === "") return;
      var scoped = scopedSyncKey(baseKey, pid);
      var sessionVal = sessionStorage.getItem(scoped);
      if (!sessionVal) {
        sessionStorage.setItem(scoped, String(raw));
        merged += 1;
        return;
      }
      if (NATIVE_TS_KEYS.has(baseKey)) {
        var n = parseInt(raw, 10);
        var s = parseInt(sessionVal, 10);
        if (Number.isFinite(n) && n > 0 && (!Number.isFinite(s) || n > s)) {
          sessionStorage.setItem(scoped, String(n));
          merged += 1;
        }
      }
    });
    if (merged > 0) {
      log("État sync restauré depuis stockage natif (" + merged + " clé(s))");
    }
    reconcileLocalBackfillState(token);
    return { hydrated: merged > 0, merged: merged };
  }

  window.PcpHealthSyncStorage = {
    FULL_BACKFILL_KEY: FULL_BACKFILL_KEY,
    BACKFILL_PENDING_KEY: BACKFILL_PENDING_KEY,
    HISTORICAL_CHECKPOINT_KEY: HISTORICAL_CHECKPOINT_KEY,
    LAST_DATA_SYNC_KEY: LAST_DATA_SYNC_KEY,
    STEPS_REPAIR_KEY: STEPS_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_KEY: SLEEP_STAGES_REPAIR_KEY,
    SCORING_90D_REPAIR_KEY: SCORING_90D_REPAIR_KEY,
    RECOVERY_RESCORE_REPAIR_KEY: RECOVERY_RESCORE_REPAIR_KEY,
    getItem: getItem,
    setItem: setItem,
    ensureSyncPatientScope: ensureSyncPatientScope,
    resolveSyncPatientId: resolveSyncPatientId,
    hydrateFromNative: hydrateFromNative,
    reconcileLocalBackfillState: reconcileLocalBackfillState,
    isFullBackfillComplete: isFullBackfillComplete,
    isBackfillPending: function (token) {
      return isBackfillPending(token);
    },
    setHistoricalBackfillPending: setHistoricalBackfillPending,
  };
})();
