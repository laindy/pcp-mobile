/**
 * Hook Android — swipe sync manuel, coaching futuriste, toasts (parité iOS).
 */
(function () {
  if (window.__pcpAndroidHealthHook) return;
  window.__pcpAndroidHealthHook = true;

  var SWIPE_THRESHOLD = 88;
  var SWIPE_MAX = 128;
  var VERTICAL_CANCEL = 36;
  var COACH_KEY = "pcpHealthSwipeCoachSeen";
  var LAST_DATA_SYNC_KEY = "pcpHealthLastDataSyncAt";
  var SIX_H_MS = 6 * 60 * 60 * 1000;
  var AUTO_SYNC_DEFER_MS = 1500;
  var __pcpManualSyncLock = false;
  var __pcpBackfillPollActive = false;
  var __pcpAutoSyncTimer = null;
  var __pcpSessionBootAt = Date.now();
  var __pcpLastRefreshToken = null;
  var __pcpShareLogsBusy = false;

  window.__pcpShareLogsDone = function (ok) {
    __pcpShareLogsBusy = false;
    if (ok) {
      showSyncToast(syncMsg("shareLogsSent"));
    } else {
      showSyncToast(syncMsg("error"), { error: true });
    }
  };

  var PERMS = {
    read: [
      "steps", "calories", "sleep", "respiratoryRate", "oxygenSaturation",
      "restingHeartRate", "heartRateVariability", "bodyTemperature", "heartRate", "vo2Max", "mindfulness", "workouts",
    ],
    write: [],
  };

  function isAndroidApp() {
    try {
      return window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === "android";
    } catch (e) {
      return false;
    }
  }

  function bridge() {
    return window.PcpHealthBridge || null;
  }

  function healthPlugin() {
    try {
      return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Health;
    } catch (e) {
      return null;
    }
  }

  function getAppLocale() {
    try {
      var match = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
      if (match && match[1]) return match[1].indexOf("en") === 0 ? "en" : "fr";
    } catch (e) {}
    return "fr";
  }

  var SYNC_MSG = {
    fr: {
      syncing: "Synchronisation en cours…",
      success: "Données santé synchronisées",
      error: "Échec de la synchronisation",
      recent: "Synchronisation récente — réessayez plus tard",
      pull: "Glissez vers la gauche pour synchroniser",
      release: "Relâchez pour synchroniser",
      error_notoken: "Connectez-vous pour synchroniser",
      error_busy: "Synchronisation déjà en cours",
      error_hc: "Installez Health Connect depuis le Play Store",
      error_session: "Session expirée — reconnectez-vous",
      empty_no_data: "Aucune donnée — autorisez PCPTherapy à lire les Pas dans Health Connect",
      error_no_steps_perm: "Autorisez PCPTherapy à lire les Pas (Health Connect → Autorisations)",
      shareLogs: "Envoyer les logs",
      shareLogsSent: "Choisissez Mail ou Drive pour envoyer le rapport",
      backfill_bg: "Historique en cours — vos données récentes sont à jour",
      backfill_blocked: "Historique en cours — patientez quelques minutes",
    },
    en: {
      syncing: "Syncing…",
      success: "Health data synced",
      error: "Sync failed",
      recent: "Recently synced — try again later",
      pull: "Swipe left to sync",
      release: "Release to sync",
      error_notoken: "Sign in to sync",
      error_busy: "Sync already in progress",
      error_hc: "Install Health Connect from the Play Store",
      error_session: "Session expired — sign in again",
      empty_no_data: "No data — allow PCPTherapy to read Steps in Health Connect",
      error_no_steps_perm: "Allow PCPTherapy to read Steps (Health Connect → Permissions)",
      shareLogs: "Send logs",
      shareLogsSent: "Choose Mail or Drive to send the report",
      backfill_bg: "History syncing — recent data is up to date",
      backfill_blocked: "History sync in progress — please wait",
    },
  };

  var BACKFILL_POLL_MS = 2500;
  var BACKFILL_POLL_MAX_MS = 45 * 60 * 1000;
  var BACKFILL_BANNER_MIN_MS = 12000;
  var __pcpBackfillBannerSince = 0;
  var __pcpBackfillBannerHideTimer = null;

  var COACH_MSG = {
    fr: {
      title: "Synchroniser vos données santé",
      body: "Sur cet écran, glissez vers la gauche pour envoyer vos données Health Connect à votre espace patient.",
      ok: "Compris",
      hint: "Glissez",
    },
    en: {
      title: "Sync your health data",
      body: "On this screen, swipe left to send your Health Connect data to your patient portal.",
      ok: "Got it",
      hint: "Swipe",
    },
  };

  function syncMsg(key) {
    var loc = getAppLocale();
    return (SYNC_MSG[loc] && SYNC_MSG[loc][key]) || SYNC_MSG.fr[key] || key;
  }

  function coachMsg(key) {
    var loc = getAppLocale();
    var m = COACH_MSG[loc] || COACH_MSG.fr;
    return m[key] || COACH_MSG.fr[key];
  }

  /** Métriques affichées côté patient — alignées frontend + backend. */
  var UI_METRICS = [
    { label: "Pas", type: "steps", dailyField: "steps_total" },
    { label: "Calories", type: "calories", dailyField: "calories_total_kcal" },
    { label: "Sommeil", type: "sleep", dailyField: "sleep_total_min" },
    { label: "HRV", type: "heartRateVariability", dailyField: "hrv_avg_ms", vitalKey: "hrv" },
    { label: "FC repos", type: "restingHeartRate", dailyField: "resting_heart_rate_avg", vitalKey: "resting_heart_rate" },
    { label: "Respiration", type: "respiratoryRate", dailyField: "respiratory_rate_avg", vitalKey: "respiratory_rate" },
    { label: "SpO₂", type: "oxygenSaturation", dailyField: "oxygen_saturation_avg", vitalKey: "oxygen_saturation" },
    { label: "Température", type: "bodyTemperature", dailyField: "body_temperature_avg", vitalKey: "body_temperature" },
    { label: "VO₂ max", type: "vo2Max", vitalKey: "vo2_max" },
    { label: "Méditation", type: "mindfulness", dailyField: "mindfulness_total_min" },
    { label: "Workouts", type: "workouts", isWorkout: true },
  ];

  function log(msg) {
    try {
      var line = "[Android] " + String(msg);
      console.log("[PcpHealth]", line);
      if (window.PcpHealthLogExport && window.PcpHealthLogExport.push) {
        window.PcpHealthLogExport.push(line);
      }
    } catch (e) {}
  }

  function syncStorage() {
    return window.PcpHealthSyncStorage || null;
  }

  async function hydrateSyncState(token) {
    var storage = syncStorage();
    if (!storage || !token) return;
    storage.ensureSyncPatientScope(token);
    try {
      await storage.hydrateFromNative(token);
    } catch (e) {}
    storage.reconcileLocalBackfillState(token);
    syncBackfillBanner();
    if (isBackfillUiActive() && !__pcpBackfillPollActive) {
      pollBackfillUntilDone(token, { emitStart: false, emitFinish: false });
    }
  }

  function isBackfillActive(token) {
    return isBackfillUiActive();
  }

  function nativeConfirmForSync() {
    return new Promise(function (resolve) {
      var b = bridge();
      if (!b || !b.confirmPermissionRationale) {
        resolve(false);
        return;
      }
      var id = "manual" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      window.__pcpHcConfirm = window.__pcpHcConfirm || {};
      window.__pcpHcConfirm[id] = function (ok) {
        resolve(!!ok);
      };
      try {
        b.confirmPermissionRationale(id);
      } catch (e) {
        delete window.__pcpHcConfirm[id];
        resolve(false);
      }
      setTimeout(function () {
        if (window.__pcpHcConfirm[id]) {
          delete window.__pcpHcConfirm[id];
          resolve(false);
        }
      }, 120000);
    });
  }

  async function requestHealthAuthForManualSync() {
    var hcStatus = peekHcStatus();
    if (hcStatus !== 0) {
      var b = bridge();
      if (b && b.ensureHealthConnectInstalled) b.ensureHealthConnectInstalled();
      return { granted: 0, error: "hc_unavailable" };
    }
    var before = countHcReadGranted();
    if (before > 0) return { granted: before };

    log("Sync manuelle — popup rationale puis écran Health Connect…");
    var ok = await nativeConfirmForSync();
    if (!ok) {
      log("Autorisation HC refusée ou annulée");
      return { granted: 0, cancelled: true };
    }
    await new Promise(function (r) {
      setTimeout(r, 500);
    });
    var after = countHcReadGranted();
    if (after > 0 && before === 0) {
      try {
        window.dispatchEvent(new CustomEvent("pcp-health-authorized", { detail: { granted: after } }));
      } catch (e) {}
    }
    return { granted: after, requestedAuth: true, cancelled: after === 0 };
  }

  function pollBackfillUntilDone(token, options) {
    var opts = options || {};
    if (__pcpBackfillPollActive) return;
    if (!isBackfillUiActive()) return;
    __pcpBackfillPollActive = true;
    var started = Date.now();
    var storage = syncStorage();

    function tick() {
      if (!__pcpBackfillPollActive) return;
      if (!isBackfillUiActive()) {
        __pcpBackfillPollActive = false;
        window.__pcpHealthBackfillRunning = false;
        if (storage && token) storage.setHistoricalBackfillPending(token, false);
        if (opts.emitFinish !== false) {
          dispatchSyncEvent("pcp-health-backfill-finished", { ok: true });
        }
        return;
      }
      if (Date.now() - started >= BACKFILL_POLL_MAX_MS) {
        __pcpBackfillPollActive = false;
        window.__pcpHealthBackfillRunning = false;
        if (opts.emitFinish !== false) {
          dispatchSyncEvent("pcp-health-backfill-finished", { ok: false, reason: "timeout" });
        }
        showBackfillBanner({ forceError: true });
        log("Backfill historique — polling timeout");
        return;
      }
      setTimeout(tick, BACKFILL_POLL_MS);
    }
    setTimeout(tick, BACKFILL_POLL_MS);
  }

  async function maybeSkipServerBackfillBeforeSync(token) {
    await hydrateSyncState(token);
    var probe = window.PcpHealthServerBackfillProbe;
    if (!probe || !probe.maybeSkipBackfillFromServer || !token) return;
    var b = bridge();
    var storage = syncStorage();
    try {
      await probe.maybeSkipBackfillFromServer(
        {
          isFullBackfillComplete: function () {
            if (storage) return storage.isFullBackfillComplete(token);
            return b && b.getFullBackfillAt && b.getFullBackfillAt() > 0;
          },
          isBackfillPending: function () {
            return isBackfillActive(token);
          },
          setFullBackfillComplete: function (ts) {
            var t = ts || Date.now();
            if (storage) storage.setItem(storage.FULL_BACKFILL_KEY, String(t), token);
            if (b && b.markServerBackfillComplete) b.markServerBackfillComplete(t);
          },
          clearBackfillPending: function () {
            if (storage) storage.setHistoricalBackfillPending(token, false);
          },
          getLastDataSyncAt: function () {
            if (storage) {
              return (
                parseInt(storage.getItem(storage.LAST_DATA_SYNC_KEY, token) || "0", 10) || 0
              );
            }
            try {
              var info = b && b.getLastSyncInfo ? JSON.parse(b.getLastSyncInfo()) : {};
              return info.lastDataSyncAt || info.lastSyncAt || 0;
            } catch (e) {
              return 0;
            }
          },
          log: log,
          sessionLog: log,
        },
        token,
        {},
      );
    } catch (e) {
      log("Probe serveur backfill: " + (e && e.message ? e.message : e));
    }
    if (storage) storage.reconcileLocalBackfillState(token);
  }

  function logNativeSyncState(info) {
    info = info || parseSyncInfo();
    log("──── État sync natif ────");
    log("  outcome=" + (info.lastOutcome || "—") + " attempt=" + (info.lastAttemptAt || 0));
    log("  lastSyncAt=" + (info.lastSyncAt ? new Date(info.lastSyncAt).toISOString() : "jamais"));
    log("  inserts: samples=" + (info.lastInserted || 0) + " aggregates=" + (info.lastAggregatesInserted || 0));
    if (info.lastMessage) log("  message: " + info.lastMessage);
    log("  HC granted=" + countHcReadGranted() + " stepsPerm=" + (bridge() && bridge().hasStepsReadPermission ? bridge().hasStepsReadPermission() : "?"));
  }

  function storeSyncSummary(text) {
    try {
      sessionStorage.setItem("pcpHealthLastSyncSummary", String(text || ""));
    } catch (e) {}
  }

  async function logTemperatureDiagnosticsAndroid(token) {
    if (!token) return;
    try {
      var res = await fetch("/api/v1/patients/me/health/samples?data_type=bodyTemperature&page_size=50", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      if (!res.ok) {
        log("  Température en base: HTTP " + res.status);
        return;
      }
      var page = await res.json();
      var items = page && page.items ? page.items : [];
      var total = page.total != null ? page.total : items.length;
      if (items.length === 0) {
        log(
          "  Température en base: 0 sample — autoriser Température corporelle + Température cutanée (poignet) dans Health Connect",
        );
        return;
      }
      items.sort(function (a, b) {
        return new Date(b.start_at).getTime() - new Date(a.start_at).getTime();
      });
      var wrist = items.filter(function (s) {
        return s && s.extra && String(s.extra.origin || s.extra.hkType || "").toLowerCase().indexOf("wrist") >= 0;
      });
      var latest = items[0];
      log(
        "  Température en base: " +
          total +
          " sample(s) | poignet=" +
          wrist.length +
          " | dernier=" +
          latest.value +
          " " +
          latest.unit +
          " @ " +
          latest.start_at +
          (latest.extra && latest.extra.origin ? " origin=" + latest.extra.origin : ""),
      );
      for (var j = 0; j < Math.min(3, items.length); j++) {
        var s = items[j];
        var origin = s.extra && (s.extra.origin || s.extra.hkType) ? s.extra.origin || s.extra.hkType : "—";
        log(
          "      · " +
            s.value +
            " " +
            s.unit +
            " @ " +
            s.start_at +
            (origin !== "—" ? " (" + origin + ")" : ""),
        );
      }
    } catch (e) {
      log("  Température en base: " + (e && e.message ? e.message : e));
    }
  }

  async function logVo2DiagnosticsAndroid(token) {
    if (!token) return;
    try {
      var res = await fetch("/api/v1/patients/me/health/samples?data_type=vo2Max&page_size=50", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      if (!res.ok) {
        log("  VO₂ max en base: HTTP " + res.status);
        return;
      }
      var page = await res.json();
      var items = page && page.items ? page.items : [];
      var total = page.total != null ? page.total : items.length;
      if (items.length === 0) {
        log(
          "  VO₂ max en base: 0 sample (total=" +
            total +
            ") — autoriser VO₂ max dans Health Connect",
        );
        return;
      }
      items.sort(function (a, b) {
        return new Date(b.start_at).getTime() - new Date(a.start_at).getTime();
      });
      var latest = items[0];
      var min = Infinity;
      var max = -Infinity;
      for (var i = 0; i < items.length; i++) {
        var v = Number(items[i].value);
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      log(
        "  VO₂ max en base: " +
          total +
          " sample(s) | dernier=" +
          latest.value +
          " " +
          latest.unit +
          " @ " +
          latest.start_at +
          (items.length > 1 && Number.isFinite(min)
            ? " | min–max=" + Math.round(min * 10) / 10 + "–" + Math.round(max * 10) / 10
            : ""),
      );
      for (var j = 0; j < Math.min(3, items.length); j++) {
        var s = items[j];
        log(
          "      · " +
            s.value +
            " " +
            s.unit +
            " @ " +
            s.start_at +
            (s.source_name ? " (" + s.source_name + ")" : ""),
        );
      }
    } catch (e) {
      log("  VO₂ max en base: " + (e && e.message ? e.message : e));
    }
  }

  async function logSleepStageDiagnosticsAndroid(token, dailyLatest) {
    var day = dailyLatest && dailyLatest.day;
    var ss = dailyLatest && dailyLatest.extra && dailyLatest.extra.sleep_stages;
    if (ss && typeof ss === "object") {
      log("  Sommeil stades " + day + " (backend extra.sleep_stages):");
      log(
        "    awake=" +
          (ss.awake_min != null ? ss.awake_min : "—") +
          " rem=" +
          (ss.rem_min != null ? ss.rem_min : "—") +
          " core=" +
          (ss.core_min != null ? ss.core_min : "—") +
          " deep=" +
          (ss.deep_min != null ? ss.deep_min : "—") +
          " min",
      );
      log(
        "    réparateur=" +
          (ss.restorative_min != null ? ss.restorative_min : "—") +
          " min (" +
          (ss.restorative_pct != null ? ss.restorative_pct + "%" : "—") +
          ")",
      );
    } else if (day) {
      log(
        "  Sommeil stades " +
          day +
          ": extra.sleep_stages absent — backend sans stades ou nuit sans segments stagés",
      );
    }
    if (!token) return;
    try {
      var res = await fetch("/api/v1/patients/me/health/samples?data_type=sleep&page_size=20", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      if (!res.ok) {
        log("  Sommeil stades samples: HTTP " + res.status);
        return;
      }
      var page = await res.json();
      var items = page && page.items ? page.items : [];
      var withStage = items.filter(function (s) {
        return s && s.extra && s.extra.stage;
      });
      log(
        "  Sommeil stades en base: " +
          withStage.length +
          "/" +
          items.length +
          " récent(s) avec extra.stage (total=" +
          (page.total != null ? page.total : "?") +
          ")",
      );
      for (var j = 0; j < Math.min(5, withStage.length); j++) {
        var s = withStage[j];
        log("      · stage=" + s.extra.stage + " " + s.value + " " + s.unit + " @ " + s.start_at);
      }
      if (items.length > 0 && withStage.length === 0) {
        log("      · note: aucun stage en base — rebuild app + resync complète requis");
      }
    } catch (e) {
      log("  Sommeil stades samples: " + (e && e.message ? e.message : e));
    }
  }

  async function verifyBackendHealthData(token) {
    if (!token) {
      log("──── Backend (GET) — pas de token ────");
      return;
    }
    log("──── Vérification lecture backend (GET) ────");
    var headers = { Authorization: "Bearer " + token };
    var dailyLatest = null;

    try {
      var dailyRes = await fetch("/api/v1/patients/me/health/daily?limit=1", {
        headers: headers,
        cache: "no-store",
      });
      if (dailyRes.ok) {
        var dailyList = await dailyRes.json();
        dailyLatest = Array.isArray(dailyList) && dailyList.length > 0 ? dailyList[0] : null;
        if (dailyLatest) {
          log(
            "  Daily " +
              dailyLatest.day +
              ": pas=" +
              (dailyLatest.steps_total != null ? dailyLatest.steps_total : "—") +
              " cal=" +
              (dailyLatest.calories_total_kcal != null ? dailyLatest.calories_total_kcal : "—") +
              " sommeil_min=" +
              (dailyLatest.sleep_total_min != null ? dailyLatest.sleep_total_min : "—") +
              " dist_m=" +
              (dailyLatest.distance_total_m != null ? dailyLatest.distance_total_m : "—") +
              " hrv=" +
              (dailyLatest.hrv_avg_ms != null ? dailyLatest.hrv_avg_ms : "—") +
              " fc_repos=" +
              (dailyLatest.resting_heart_rate_avg != null ? dailyLatest.resting_heart_rate_avg : "—") +
              " resp=" +
              (dailyLatest.respiratory_rate_avg != null ? dailyLatest.respiratory_rate_avg : "—") +
              " spo2=" +
              (dailyLatest.oxygen_saturation_avg != null ? dailyLatest.oxygen_saturation_avg : "—") +
              " effort=" +
              (dailyLatest.effort_score != null ? dailyLatest.effort_score : "—"),
          );
          await logSleepStageDiagnosticsAndroid(token, dailyLatest);
          await logVo2DiagnosticsAndroid(token);
          await logTemperatureDiagnosticsAndroid(token);
        } else {
          log("  Daily: aucune ligne en base");
        }
      } else {
        log("  Daily: HTTP " + dailyRes.status);
      }
    } catch (e) {
      log("  Daily: " + (e && e.message ? e.message : e));
    }

    var vitals = null;
    try {
      var vitalsRes = await fetch("/api/v1/patients/me/health/vitals/latest", {
        headers: headers,
        cache: "no-store",
      });
      if (vitalsRes.ok) {
        vitals = await vitalsRes.json();
      } else {
        log("  Vitals: HTTP " + vitalsRes.status);
      }
    } catch (e) {
      log("  Vitals: " + (e && e.message ? e.message : e));
    }

    for (var i = 0; i < UI_METRICS.length; i++) {
      var m = UI_METRICS[i];
      if (m.isWorkout) {
        try {
          var wRes = await fetch("/api/v1/patients/me/health/workouts?page_size=1", {
            headers: headers,
            cache: "no-store",
          });
          if (!wRes.ok) {
            log("  ○ " + m.label + " HTTP " + wRes.status);
            continue;
          }
          var wPage = await wRes.json();
          var wTotal = wPage.total || 0;
          var wLatest = wPage.items && wPage.items[0];
          log(
            "  " +
              (wTotal > 0 ? "✓" : "○") +
              " " +
              m.label +
              " total=" +
              wTotal +
              " dernier=" +
              (wLatest ? wLatest.workout_type + " @ " + wLatest.start_at : "—"),
          );
        } catch (e) {
          log("  ○ " + m.label + " " + (e && e.message ? e.message : e));
        }
        continue;
      }

      var vitalVal = m.vitalKey && vitals && vitals[m.vitalKey] ? vitals[m.vitalKey].value : null;
      try {
        var sRes = await fetch(
          "/api/v1/patients/me/health/samples?data_type=" + encodeURIComponent(m.type) + "&page_size=1",
          { headers: headers, cache: "no-store" },
        );
        if (!sRes.ok) {
          log("  ○ " + m.label + " " + m.type + " HTTP " + sRes.status);
          continue;
        }
        var sPage = await sRes.json();
        var sTotal = sPage.total || 0;
        var sLatest = sPage.items && sPage.items[0];
        var detail = sLatest ? sLatest.value + " " + sLatest.unit + " @ " + sLatest.start_at : "—";
        if (m.type === "sleep" && sLatest && sLatest.extra && sLatest.extra.stage) {
          detail += " | stage=" + sLatest.extra.stage;
        }
        if (m.dailyField && dailyLatest && dailyLatest[m.dailyField] != null) {
          detail += " | agrégat=" + dailyLatest[m.dailyField];
        }
        if (vitalVal != null) {
          detail += " | vital=" + vitalVal;
        }
        if (m.type === "sleep" && sTotal > 0 && sLatest && !(sLatest.extra && sLatest.extra.stage)) {
          detail += " | note: sample sans extra.stage — app ancienne ou resync requis";
        }
        if (m.type === "vo2Max" && sTotal === 0) {
          detail += " | note: mesures éparses — autoriser VO₂ max dans Health Connect";
        }
        if (m.type === "bodyTemperature" && sTotal === 0) {
          detail += " | note: autoriser Température corporelle + Température cutanée (poignet) dans Health Connect";
        }
        log("  " + (sTotal > 0 ? "✓" : "○") + " " + m.label + " " + m.type + " total=" + sTotal + " " + detail);
      } catch (e) {
        log("  ○ " + m.label + " " + (e && e.message ? e.message : e));
      }
    }
  }

  var __pcpLogShareNavPath = null;
  var __pcpLogShareNavHideTimer = null;
  var LOG_SHARE_NAV_HIDE_MS = 4000;

  function installLogShareNavDismiss() {
    if (window.__pcpLogShareNavDismiss) return;
    window.__pcpLogShareNavDismiss = true;
    setInterval(function () {
      try {
        var path = window.location.pathname || "";
        if (__pcpLogShareNavPath == null) {
          __pcpLogShareNavPath = path;
          return;
        }
        if (path === __pcpLogShareNavPath) return;
        __pcpLogShareNavPath = path;
        var el = document.getElementById("pcp-health-log-share-btn");
        if (!el || el.style.display === "none") return;
        clearTimeout(__pcpLogShareNavHideTimer);
        __pcpLogShareNavHideTimer = setTimeout(function () {
          __pcpLogShareNavHideTimer = null;
          hideLogSharePrompt();
        }, LOG_SHARE_NAV_HIDE_MS);
      } catch (e) {}
    }, 700);
  }

  function hideLogSharePrompt() {
    clearTimeout(__pcpLogShareNavHideTimer);
    __pcpLogShareNavHideTimer = null;
    var el = document.getElementById("pcp-health-log-share-btn");
    if (el) el.style.display = "none";
  }

  function showLogSharePrompt() {
    if (!window.PcpHealthLogExport) return;
    installLogShareNavDismiss();
    var id = "pcp-health-log-share-btn";
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement("button");
      el.id = id;
      el.type = "button";
      el.style.cssText =
        "position:fixed;bottom:calc(72px + var(--pcp-safe-bottom, env(safe-area-inset-bottom, 0px)));left:50%;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:999px;border:none;background:#1e40af;color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.22);cursor:pointer;max-width:min(calc(100vw - 24px), 340px);";
      el.addEventListener("click", function () {
        if (__pcpShareLogsBusy) return;
        shareSyncLogs();
      });
      document.body.appendChild(el);
    }
    el.textContent = syncMsg("shareLogs");
    el.style.display = "block";
    clearTimeout(__pcpLogShareNavHideTimer);
    __pcpLogShareNavHideTimer = null;
    try {
      __pcpLogShareNavPath = window.location.pathname || "";
    } catch (e) {}
  }

  async function shareSyncLogs() {
    if (__pcpShareLogsBusy) return;
    try {
      if (!window.PcpHealthLogExport || !window.PcpHealthLogExport.share) {
        showSyncToast(syncMsg("error"), { error: true });
        return;
      }
      __pcpShareLogsBusy = true;
      var result = await window.PcpHealthLogExport.share();
      if (result && result.pending) {
        return;
      }
      __pcpShareLogsBusy = false;
      if (result && result.ok) {
        showSyncToast(syncMsg("shareLogsSent"));
      } else {
        showSyncToast(syncMsg("error"), { error: true });
      }
    } catch (e) {
      __pcpShareLogsBusy = false;
      showSyncToast(syncMsg("error"), { error: true });
    }
  }

  function dismissSyncToast() {
    try {
      var el = document.getElementById("pcp-health-sync-toast");
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (e) {}
  }

  function isBackfillUiActive() {
    if (window.__pcpHealthBackfillRunning === true) return true;
    var storage = syncStorage();
    try {
      if (storage && storage.isFullBackfillComplete && storage.isFullBackfillComplete()) {
        return false;
      }
      if (storage && storage.isBackfillPending()) return true;
    } catch (e) {}
    var b = bridge();
    try {
      if (b && b.isBackfillRunning && b.isBackfillRunning()) return true;
      if (b && b.isBackfillPending && b.isBackfillPending()) return true;
    } catch (e) {}
    return false;
  }

  function shouldShowBackfillBanner() {
    return isBackfillUiActive();
  }

  function showBackfillBanner(opts) {
    try {
      var options = opts || {};
      if (!options.forceError && !shouldShowBackfillBanner()) return;
      var id = "pcp-health-backfill-banner";
      var existing = document.getElementById(id);
      if (window.__pcpBackfillBannerVisible && existing && existing.style.display === "block" && !options.forceError) {
        return;
      }
      dismissSyncToast();
      if (!window.__pcpBackfillBannerVisible) {
        __pcpBackfillBannerSince = Date.now();
      }
      window.__pcpBackfillBannerVisible = true;
      clearTimeout(__pcpBackfillBannerHideTimer);
      var el = existing;
      if (!el) {
        el = document.createElement("div");
        el.id = id;
        el.setAttribute("role", "status");
        el.style.cssText =
          "position:fixed;bottom:calc(72px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);" +
          "z-index:99999;pointer-events:none;max-width:min(calc(100vw - 24px),340px);width:max-content;display:none";
        el.innerHTML =
          '<div style="display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-radius:16px;' +
          'background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;box-shadow:0 8px 24px rgba(30,64,175,.32);' +
          'font:600 12px/1.35 system-ui,sans-serif;text-align:left">' +
          '<span style="flex:0 0 auto;width:8px;height:8px;margin-top:4px;border-radius:50%;background:#93c5fd;' +
          'animation:pcpBackfillDot 1.6s ease-in-out infinite"></span>' +
          '<span style="flex:1;min-width:0"><span id="pcp-health-backfill-banner-title" style="display:block;font-size:13px"></span>' +
          '<span id="pcp-health-backfill-banner-sub" style="display:block;margin-top:2px;font-weight:500;font-size:11px;opacity:.9"></span></span></div>';
        if (!document.getElementById("pcp-backfill-banner-style")) {
          var st = document.createElement("style");
          st.id = "pcp-backfill-banner-style";
          st.textContent =
            "@keyframes pcpBackfillDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.88)}}";
          document.head.appendChild(st);
        }
        document.body.appendChild(el);
      }
      var loc = getAppLocale();
      var titleEl = document.getElementById("pcp-health-backfill-banner-title");
      var subEl = document.getElementById("pcp-health-backfill-banner-sub");
      if (options.forceError) {
        if (titleEl) titleEl.textContent = loc === "en" ? "History import interrupted" : "Import historique interrompu";
        if (subEl) {
          subEl.textContent =
            loc === "en" ? "Swipe left on Home to resume" : "Glissez à gauche sur l'accueil pour reprendre";
        }
      } else {
        if (titleEl) {
          titleEl.textContent = loc === "en" ? "History import in progress" : "Import historique en cours";
        }
        if (subEl) {
          subEl.textContent =
            loc === "en"
              ? "7 days synced — fetching up to 1 year"
              : "7 j synchronisés — récupération jusqu'à 1 an";
        }
      }
      el.style.display = "block";
      log("[UI] Bandeau import historique affiché");
    } catch (e) {}
  }

  function hideBackfillBanner(force) {
    try {
      if (isBackfillUiActive() && !force) {
        showBackfillBanner();
        return;
      }
      if (!window.__pcpBackfillBannerVisible && !__pcpBackfillBannerHideTimer && !force) return;
      var elapsed = __pcpBackfillBannerSince ? Date.now() - __pcpBackfillBannerSince : BACKFILL_BANNER_MIN_MS;
      var wait = force ? 0 : Math.max(0, BACKFILL_BANNER_MIN_MS - elapsed);
      clearTimeout(__pcpBackfillBannerHideTimer);
      __pcpBackfillBannerHideTimer = setTimeout(function () {
        __pcpBackfillBannerHideTimer = null;
        if (isBackfillUiActive()) {
          showBackfillBanner();
          return;
        }
        if (!window.__pcpBackfillBannerVisible) return;
        window.__pcpBackfillBannerVisible = false;
        var el = document.getElementById("pcp-health-backfill-banner");
        if (el) el.style.display = "none";
        log("[UI] Bandeau import historique masqué");
      }, wait);
    } catch (e) {}
  }

  function syncBackfillBanner() {
    if (shouldShowBackfillBanner()) showBackfillBanner();
    else if (window.__pcpBackfillBannerVisible || __pcpBackfillBannerHideTimer) {
      hideBackfillBanner(false);
    } else {
      window.__pcpHealthBackfillRunning = false;
      __pcpBackfillPollActive = false;
    }
  }

  window.showBackfillBanner = showBackfillBanner;
  window.hideBackfillBanner = hideBackfillBanner;
  window.syncBackfillBanner = syncBackfillBanner;

  function getLastDataSyncMs() {
    var last = 0;
    try {
      last = parseInt(sessionStorage.getItem(LAST_DATA_SYNC_KEY) || "0", 10) || 0;
    } catch (e) {}
    var info = parseSyncInfo();
    if (info.lastDataSyncAt && info.lastDataSyncAt > last) {
      last = info.lastDataSyncAt;
      try {
        sessionStorage.setItem(LAST_DATA_SYNC_KEY, String(last));
      } catch (e) {}
    }
    return last;
  }

  function shouldRunBackgroundAutoSync() {
    var last = getLastDataSyncMs();
    if (!last) return true;
    return Date.now() - last >= SIX_H_MS;
  }

  function scheduleBackgroundAutoSync() {
    if (__pcpManualSyncLock) return;
    if (__pcpAutoSyncTimer) clearTimeout(__pcpAutoSyncTimer);
    __pcpAutoSyncTimer = setTimeout(function () {
      __pcpAutoSyncTimer = null;
      runBackgroundHealthSync();
    }, AUTO_SYNC_DEFER_MS);
  }

  async function runBackgroundHealthSync() {
    var b = bridge();
    if (!b) return;
    if (!shouldRunBackgroundAutoSync()) return;
    if (peekHcStatus() !== 0 || countHcReadGranted() === 0) return;
    var freshToken = await ensureFreshAccessToken();
    if (!freshToken) return;
    pushTokenToNative(freshToken);
    if (!b.hasToken || !b.hasToken()) return;
    await hydrateSyncState(freshToken);
    await maybeSkipServerBackfillBeforeSync(freshToken);
    if (b.enqueueHealthSync) b.enqueueHealthSync();
  }

  function showSyncToast(message, options) {
    try {
      var opts = typeof options === "boolean" ? { error: !!options } : options || {};
      var id = "pcp-health-sync-toast";
      var existing = document.getElementById(id);
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
      var wrap = document.createElement("div");
      wrap.id = id;
      wrap.style.position = "fixed";
      wrap.style.left = "0";
      wrap.style.right = "0";
      wrap.style.bottom = "calc(20px + env(safe-area-inset-bottom))";
      wrap.style.zIndex = "99999";
      wrap.style.display = "flex";
      wrap.style.justifyContent = "center";
      wrap.style.alignItems = "center";
      wrap.style.pointerEvents = "none";
      wrap.style.padding = "0 12px";
      wrap.style.boxSizing = "border-box";

      var pill = document.createElement("span");
      pill.style.display = "inline-block";
      pill.style.width = "auto";
      pill.style.maxWidth = "min(calc(100vw - 24px), 340px)";
      pill.style.boxSizing = "border-box";
      pill.style.padding = "10px 14px";
      pill.style.borderRadius = "999px";
      pill.style.textAlign = "center";
      pill.style.whiteSpace = message.length > 42 ? "normal" : "nowrap";
      pill.style.font = "600 13px/1.35 system-ui,sans-serif";
      pill.style.color = "#fff";
      pill.style.boxShadow = "0 8px 24px rgba(0,0,0,0.18)";
      pill.style.opacity = "1";
      pill.style.transition = "opacity .25s ease";
      pill.textContent = message;
      pill.style.background = opts.error
        ? "rgba(220,38,38,0.95)"
        : opts.warn
          ? "rgba(180,83,9,0.94)"
          : opts.persist
            ? "rgba(30,64,175,0.94)"
            : "rgba(15,23,42,0.92)";

      wrap.appendChild(pill);
      document.body.appendChild(wrap);
      clearTimeout(wrap.__hideTimer);
      if (!opts.persist) {
        wrap.__hideTimer = setTimeout(function () {
          pill.style.opacity = "0";
        }, opts.error ? 4500 : 3000);
      }
    } catch (e) {}
  }

  function parseSyncInfo() {
    var b = bridge();
    if (!b || !b.getLastSyncInfo) return {};
    try {
      return JSON.parse(b.getLastSyncInfo() || "{}");
    } catch (e) {
      return {};
    }
  }

  function peekHcStatus() {
    var b = bridge();
    if (b && b.peekHealthConnectStatus) return b.peekHealthConnectStatus();
    return 3;
  }

  function countHcReadGranted() {
    var b = bridge();
    if (b && b.getHealthConnectGrantedCount) {
      try {
        return b.getHealthConnectGrantedCount() | 0;
      } catch (e) {}
    }
    return 0;
  }

  function dispatchSyncEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (e) {}
  }

  function jwtExpMs(token) {
    try {
      var parts = String(token || "").split(".");
      if (parts.length < 2) return 0;
      var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var json = JSON.parse(atob(b64));
      return (json.exp || 0) * 1000;
    } catch (e) {
      return 0;
    }
  }

  function isAccessTokenExpired(token, skewSec) {
    var exp = jwtExpMs(token);
    if (!exp) return true;
    var skew = (skewSec != null ? skewSec : 90) * 1000;
    return Date.now() >= exp - skew;
  }

  async function fetchSessionTokens() {
    try {
      var res = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
      if (!res.ok) return null;
      var data = await res.json();
      if (!data || !data.user) return null;
      return {
        accessToken: data.user.accessToken || null,
        refreshToken: data.user.refreshToken || null,
      };
    } catch (e) {
      return null;
    }
  }

  async function refreshAccessTokenFromRefresh(refreshToken) {
    if (!refreshToken) return null;
    try {
      var res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return null;
      var data = await res.json();
      if (!data || !data.access_token) return null;
      if (data.refresh_token) __pcpLastRefreshToken = data.refresh_token;
      return data.access_token;
    } catch (e) {
      return null;
    }
  }

  async function ensureFreshAccessToken() {
    var session = await fetchSessionTokens();
    var access = session && session.accessToken ? session.accessToken : null;
    if (session && session.refreshToken) {
      __pcpLastRefreshToken = session.refreshToken;
    }
    if (access && !isAccessTokenExpired(access)) {
      return access;
    }
    var refreshed = await refreshAccessTokenFromRefresh(__pcpLastRefreshToken);
    if (refreshed) return refreshed;
    if (access && !isAccessTokenExpired(access, 0)) return access;
    return null;
  }

  async function resolveSyncAuthToken() {
    var token = await ensureFreshAccessToken();
    if (token) return token;
    await new Promise(function (r) {
      setTimeout(r, 500);
    });
    return ensureFreshAccessToken();
  }

  function pushTokenToNative(token) {
    var b = bridge();
    if (!b || !token) return false;
    try {
      if (b.updateToken) {
        b.updateToken(token);
      } else if (b.setToken) {
        b.setToken(token);
      } else {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function formatEmptySync(info) {
    var msg = (info && info.lastMessage) || "";
    if (/google fit|health connect/i.test(msg)) {
      var short = msg.length > 110 ? msg.slice(0, 110) + "…" : msg;
      return short;
    }
    return syncMsg("empty_no_data");
  }

  function formatSyncError(info) {
    var msg = (info && info.lastMessage) || "";
    if (/auth\s*\(401\)|auth\s*\(403\)|reconnectez|session expir/i.test(msg)) {
      return syncMsg("error_session");
    }
    if (/pas de token/i.test(msg)) {
      return syncMsg("error_session");
    }
    if (/health connect indisponible/i.test(msg)) {
      return syncMsg("error_hc");
    }
    if (msg) {
      var short = msg.length > 72 ? msg.slice(0, 72) + "…" : msg;
      return syncMsg("error") + " — " + short;
    }
    return syncMsg("error");
  }

  function captureNativeBridge() {
    return bridge();
  }

  function waitForSyncResult(sinceAttemptAt, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      var floor = sinceAttemptAt || 0;
      var tick = function () {
        var info = parseSyncInfo();
        var attempt = info.lastAttemptAt || 0;
        if (attempt >= floor) {
          var outcome = info.lastOutcome || "";
          if (outcome === "running" || outcome === "") {
            if (Date.now() - start >= timeoutMs) {
              resolve({ ok: null, info: info, timeout: true });
              return;
            }
            setTimeout(tick, 600);
            return;
          }
          if (outcome === "ok") {
            resolve({ ok: true, info: info });
            return;
          }
          if (outcome === "empty") {
            resolve({ ok: false, empty: true, info: info });
            return;
          }
          if (outcome === "error") {
            resolve({ ok: false, info: info });
            return;
          }
        }
        if (Date.now() - start >= timeoutMs) {
          resolve({ ok: null, info: info, timeout: true });
          return;
        }
        setTimeout(tick, 600);
      };
      setTimeout(tick, 200);
    });
  }

  function nativeTriggerSync() {
    var b = bridge();
    if (b && typeof b.enqueueHealthSync === "function") {
      b.enqueueHealthSync();
    }
  }

  async function runManualHealthSync() {
    var b = bridge();
    if (!b || __pcpManualSyncLock) {
      if (__pcpManualSyncLock) {
        dispatchSyncEvent("pcp-health-sync-finished", { manual: true, skipped: true, reason: "busy" });
        showSyncToast(syncMsg("error_busy"), { warn: true });
      }
      return;
    }

    var freshToken = await resolveSyncAuthToken();
    if (!freshToken) {
      dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: false, reason: "auth_expired" });
      return;
    }
    pushTokenToNative(freshToken);
    await hydrateSyncState(freshToken);

    if (isBackfillActive(freshToken) && b.isBackfillRunning && b.isBackfillRunning()) {
      dispatchSyncEvent("pcp-health-sync-finished", {
        manual: true,
        skipped: true,
        reason: "backfill_running",
      });
      showSyncToast(syncMsg("backfill_blocked"), { warn: true });
      return;
    }

    var hcStatus = peekHcStatus();
    if (hcStatus !== 0) {
      dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: false, reason: "hc_unavailable" });
      showSyncToast(syncMsg("error_hc"), { warn: true });
      if (b.ensureHealthConnectInstalled) b.ensureHealthConnectInstalled();
      return;
    }
    var granted = countHcReadGranted();
    if (granted === 0) {
      var authResult = await requestHealthAuthForManualSync();
      if (authResult.cancelled) {
        dispatchSyncEvent("pcp-health-sync-finished", {
          manual: true,
          skipped: true,
          reason: "auth_cancelled",
        });
        return;
      }
      granted = authResult.granted || 0;
      if (granted === 0) {
        dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: false, reason: "no_auth" });
        showSyncToast(syncMsg("error_hc"), { warn: true });
        return;
      }
    }
    if (b.hasStepsReadPermission && !b.hasStepsReadPermission()) {
      dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: false, reason: "no_steps_perm" });
      showSyncToast(syncMsg("error_no_steps_perm"), { warn: true });
      if (b.confirmPermissionRationale) {
        var rid = "steps" + Date.now().toString(36);
        window.__pcpHcConfirm = window.__pcpHcConfirm || {};
        window.__pcpHcConfirm[rid] = function (ok) {
          if (ok) runManualHealthSync();
        };
        try { b.confirmPermissionRationale(rid); } catch (e) {}
      }
      return;
    }

    __pcpManualSyncLock = true;
    dispatchSyncEvent("pcp-health-sync-started", { manual: true });
    showSyncToast(syncMsg("syncing"), { persist: true });
    log("──── Sync manuelle (swipe) ────");
    logNativeSyncState();

    try {
      await maybeSkipServerBackfillBeforeSync(freshToken);
      var syncMark = parseSyncInfo().lastAttemptAt || 0;
      nativeTriggerSync();
      await new Promise(function (r) {
        setTimeout(r, 250);
      });
      var afterEnqueue = parseSyncInfo().lastAttemptAt || 0;
      if (afterEnqueue > syncMark) syncMark = afterEnqueue;
      var result = await waitForSyncResult(syncMark, 180000);
      logNativeSyncState(result.info || parseSyncInfo());
      if (result.ok) {
        try {
          sessionStorage.setItem(LAST_DATA_SYNC_KEY, String(Date.now()));
        } catch (e) {}
        var inserted = (result.info && result.info.lastInserted) || 0;
        var aggInserted = (result.info && result.info.lastAggregatesInserted) || 0;
        var infoAfter = result.info || parseSyncInfo();
        var backfillPending = isBackfillUiActive();
        storeSyncSummary("OK inserts=" + inserted + " agg=" + aggInserted);
        log("Sync OK — inserts samples=" + inserted + " aggregates=" + aggInserted);
        await verifyBackendHealthData(freshToken);
        if (window.PcpHealthConnectDisplay && window.PcpHealthConnectDisplay.applyOverlay) {
          try {
            await window.PcpHealthConnectDisplay.applyOverlay();
          } catch (e) {}
        }
        var detail = {
          manual: true,
          ok: true,
          lastInserted: inserted,
          lastAggregatesInserted: aggInserted,
          backfillPending: backfillPending,
          mode: backfillPending ? "phased_initial" : "incremental",
        };
        if (backfillPending) {
          log("Phase récente OK — historique en arrière-plan");
          showBackfillBanner();
          pollBackfillUntilDone(freshToken, { emitStart: false, emitFinish: false });
        } else {
          showSyncToast(syncMsg("success"));
        }
        dispatchSyncEvent("pcp-health-sync-finished", { ...detail, readyForUiRefresh: !backfillPending });
        if (!backfillPending && window.PcpHealthDisplayRefresh && window.PcpHealthDisplayRefresh.pulse) {
          window.PcpHealthDisplayRefresh.pulse();
        }
        dismissCoach(true);
        showLogSharePrompt();
      } else if (result.empty) {
        storeSyncSummary("empty — " + ((result.info && result.info.lastMessage) || "no data"));
        log("Sync vide — " + ((result.info && result.info.lastMessage) || "aucune donnée"));
        await verifyBackendHealthData(freshToken);
        dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: false, empty: true, reason: "no_data" });
        showSyncToast(formatEmptySync(result.info), { warn: true });
        showLogSharePrompt();
      } else if (result.timeout) {
        storeSyncSummary("timeout");
        log("Sync timeout");
        dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: null, reason: "timeout" });
        showSyncToast(syncMsg("syncing"), { warn: true });
        showLogSharePrompt();
      } else {
        storeSyncSummary("error — " + ((result.info && result.info.lastMessage) || "unknown"));
        log("Sync erreur — " + ((result.info && result.info.lastMessage) || "unknown"));
        await verifyBackendHealthData(freshToken);
        dispatchSyncEvent("pcp-health-sync-finished", { manual: true, ok: false, info: result.info });
        showSyncToast(formatSyncError(result.info), { error: true });
        showLogSharePrompt();
      }
    } finally {
      __pcpManualSyncLock = false;
    }
  }

  function wrapTriggerSync() {
    var b = captureNativeBridge();
    if (!b) return;
    b.triggerSync = function () {
      runManualHealthSync();
    };
    b.__pcpTriggerWrapped = true;
  }

  function isPatientHome() {
    try {
      return /\/patient\/home/.test(window.location.pathname || "");
    } catch (e) {
      return false;
    }
  }

  function coachSeen() {
    try {
      return localStorage.getItem(COACH_KEY) === "1";
    } catch (e) {
      return true;
    }
  }

  function dismissCoach(markSeen) {
    var el = document.getElementById("pcp-health-swipe-coach");
    if (el) el.remove();
    if (markSeen) {
      try {
        localStorage.setItem(COACH_KEY, "1");
      } catch (e) {}
    }
  }

  function ensureCoachStyles() {
    if (document.getElementById("pcp-health-coach-style")) return;
    var s = document.createElement("style");
    s.id = "pcp-health-coach-style";
    s.textContent = [
      "#pcp-health-swipe-coach{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;",
      "padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom));box-sizing:border-box;",
      "background:rgba(2,6,23,0.14);animation:pcpCoachOverlayIn .45s ease}",
      ".pcp-coach-card{position:relative;margin:0;max-width:360px;width:calc(100% - 32px);padding:28px 22px 22px;border-radius:26px;pointer-events:auto;",
      "background:linear-gradient(165deg,rgba(15,23,42,0.62),rgba(2,6,23,0.52));",
      "-webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);",
      "border:1px solid rgba(148,163,184,0.22);overflow:hidden;",
      "box-shadow:0 32px 80px rgba(2,6,23,0.5),0 0 0 1px rgba(255,255,255,0.06) inset,0 1px 0 rgba(255,255,255,0.12) inset;",
      "animation:pcpCoachCardIn .55s cubic-bezier(.22,1,.36,1)}",
      ".pcp-coach-card::after{content:'';position:absolute;top:-50%;left:50%;width:240px;height:240px;margin-left:-120px;border-radius:50%;pointer-events:none;",
      "background:radial-gradient(circle,rgba(56,189,248,0.28),rgba(56,189,248,0) 70%);filter:blur(6px);animation:pcpCoachAura 5s ease-in-out infinite}",
      ".pcp-coach-badge{position:relative;width:56px;height:56px;border-radius:17px;display:flex;align-items:center;justify-content:center;margin-bottom:18px;",
      "background:linear-gradient(145deg,rgba(56,189,248,0.22),rgba(168,85,247,0.22));border:1px solid rgba(148,163,184,0.22);",
      "box-shadow:0 0 22px rgba(56,189,248,0.28) inset,0 10px 26px rgba(2,6,23,0.5)}",
      ".pcp-coach-badge::before{content:'';position:absolute;inset:-6px;border-radius:22px;border:1px solid rgba(56,189,248,0.4);animation:pcpCoachRing 2.4s ease-out infinite}",
      ".pcp-coach-badge .material-symbols-outlined{font-size:28px;color:#e0f2fe;text-shadow:0 0 14px rgba(56,189,248,0.85)}",
      ".pcp-coach-gesture{position:relative;margin-bottom:22px;padding:18px;border-radius:18px;overflow:hidden;",
      "background:linear-gradient(145deg,rgba(30,41,59,0.55),rgba(15,23,42,0.55));border:1px solid rgba(148,163,184,0.14)}",
      ".pcp-coach-hint-row{display:flex;align-items:center;justify-content:space-between;gap:10px}",
      ".pcp-coach-hint{font:600 10px/1.2 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:#7dd3fc}",
      ".pcp-coach-chevrons{display:inline-flex;gap:1px}",
      ".pcp-coach-chevrons span{font-size:20px;line-height:1;color:#38bdf8;text-shadow:0 0 10px rgba(56,189,248,0.7);animation:pcpCoachChev 1.2s ease-in-out infinite}",
      ".pcp-coach-chevrons span:nth-child(2){animation-delay:.14s}",
      ".pcp-coach-chevrons span:nth-child(3){animation-delay:.28s}",
      ".pcp-coach-track{position:relative;height:6px;border-radius:999px;background:rgba(148,163,184,0.16);overflow:hidden;margin-top:14px}",
      ".pcp-coach-track::before{content:'';position:absolute;inset:0;border-radius:inherit;",
      "background:linear-gradient(90deg,rgba(56,189,248,0) 0%,rgba(56,189,248,0.45) 50%,rgba(56,189,248,0) 100%);",
      "transform:translateX(100%);animation:pcpCoachSweep 1.8s cubic-bezier(.65,0,.35,1) infinite}",
      ".pcp-coach-orb{position:absolute;top:50%;right:5px;width:14px;height:14px;margin-top:-7px;border-radius:50%;",
      "background:radial-gradient(circle at 32% 30%,#f0f9ff,#38bdf8);",
      "box-shadow:0 0 12px rgba(56,189,248,0.95),0 0 26px rgba(99,102,241,0.6);",
      "animation:pcpCoachSwipe 1.8s cubic-bezier(.65,0,.35,1) infinite}",
      ".pcp-coach-title{margin:0 0 10px;font:700 20px/1.25 system-ui,sans-serif;letter-spacing:-.02em;",
      "background:linear-gradient(90deg,#e0f2fe,#a5b4fc);-webkit-background-clip:text;background-clip:text;color:transparent}",
      ".pcp-coach-body{margin:0 0 22px;font:500 14px/1.55 system-ui,sans-serif;color:rgba(203,213,225,0.85)}",
      ".pcp-coach-btn{position:relative;width:100%;padding:15px 18px;border-radius:14px;cursor:pointer;",
      "font:600 15px/1 system-ui,sans-serif;color:#e2e8f0;",
      "background:rgba(255,255,255,0.08);border:1px solid rgba(148,163,184,0.28);",
      "backdrop-filter:blur(10px);transition:transform .15s ease,background .2s ease}",
      ".pcp-coach-btn:active{transform:scale(.97);background:rgba(255,255,255,0.14)}",
      "@keyframes pcpCoachOverlayIn{from{opacity:0}to{opacity:1}}",
      "@keyframes pcpCoachCardIn{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}",
      "@keyframes pcpCoachAura{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:.9;transform:scale(1.15)}}",
      "@keyframes pcpCoachRing{0%{transform:scale(.85);opacity:.8}100%{transform:scale(1.3);opacity:0}}",
      "@keyframes pcpCoachSwipe{0%{right:5px;opacity:0}14%{opacity:1}85%{opacity:1}100%{right:calc(100% - 19px);opacity:0}}",
      "@keyframes pcpCoachSweep{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}",
      "@keyframes pcpCoachChev{0%,100%{opacity:.25;transform:translateX(2px)}50%{opacity:1;transform:translateX(-2px)}}",
    ].join("");
    document.head.appendChild(s);
  }

  function showCoach() {
    if (!isAndroidApp() || !isPatientHome() || coachSeen()) return;
    if (document.getElementById("pcp-health-swipe-coach")) return;
    ensureCoachStyles();
    var overlay = document.createElement("div");
    overlay.id = "pcp-health-swipe-coach";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var card = document.createElement("div");
    card.className = "pcp-coach-card";
    var badge = document.createElement("div");
    badge.className = "pcp-coach-badge";
    var badgeIcon = document.createElement("span");
    badgeIcon.className = "material-symbols-outlined";
    badgeIcon.textContent = "swipe_left";
    badge.appendChild(badgeIcon);
    var gesture = document.createElement("div");
    gesture.className = "pcp-coach-gesture";
    var hintRow = document.createElement("div");
    hintRow.className = "pcp-coach-hint-row";
    var hintEl = document.createElement("span");
    hintEl.className = "pcp-coach-hint";
    hintEl.textContent = coachMsg("hint");
    var arrowsEl = document.createElement("span");
    arrowsEl.className = "pcp-coach-chevrons";
    arrowsEl.innerHTML = "<span>‹</span><span>‹</span><span>‹</span>";
    hintRow.appendChild(hintEl);
    hintRow.appendChild(arrowsEl);
    var track = document.createElement("div");
    track.className = "pcp-coach-track";
    var orb = document.createElement("div");
    orb.className = "pcp-coach-orb";
    track.appendChild(orb);
    gesture.appendChild(hintRow);
    gesture.appendChild(track);
    var title = document.createElement("h2");
    title.className = "pcp-coach-title";
    title.textContent = coachMsg("title");
    var body = document.createElement("p");
    body.className = "pcp-coach-body";
    body.textContent = coachMsg("body");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pcp-coach-btn";
    btn.textContent = coachMsg("ok");
    btn.addEventListener("click", function () {
      dismissCoach(true);
    });
    card.appendChild(badge);
    card.appendChild(gesture);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(btn);
    overlay.appendChild(card);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) dismissCoach(true);
    });
    document.body.appendChild(overlay);
  }

  function showCoachIfAuthorized() {
    if (!isAndroidApp() || !isPatientHome() || coachSeen()) return false;
    if (peekHcStatus() !== 0) return false;
    if (countHcReadGranted() === 0) return false;
    showCoach();
    return true;
  }

  function tryShowSwipeCoachAfterAuth() {
    window.__pcpSwipeCoachPending = true;
    setTimeout(function () {
      if (coachSeen()) {
        window.__pcpSwipeCoachPending = false;
        return;
      }
      var shown = showCoachIfAuthorized();
      if (shown) window.__pcpSwipeCoachPending = false;
    }, 1200);
  }

  function insideNestedScroller(el) {
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.noSwipeSync != null) return true;
      try {
        var style = window.getComputedStyle(el);
        var scrollableX =
          (style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1;
        var scrollableY =
          (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1;
        if (scrollableX || scrollableY) return true;
      } catch (e) {}
      el = el.parentElement;
    }
    return false;
  }

  function ensureSwipeIndicator() {
    var id = "pcp-health-swipe-indicator";
    var el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("div");
    el.id = id;
    el.style.cssText =
      "position:fixed;top:calc(4.25rem + env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));" +
      "z-index:99998;pointer-events:none;opacity:0;transition:opacity .15s ease,transform .12s ease;" +
      "width:max-content;max-width:calc(100vw - 24px)";
    el.innerHTML =
      '<div id="pcp-health-swipe-pill" style="display:inline-flex;align-items:center;padding:8px 12px;border-radius:999px;' +
      "font:600 12px/1.2 system-ui,sans-serif;background:#fff;color:#525252;border:1px solid #e5e5e5;" +
      'box-shadow:0 4px 14px rgba(0,0,0,0.08);white-space:nowrap"></div>';
    document.body.appendChild(el);
    return el;
  }

  function updateSwipeIndicator(distance) {
    var wrap = ensureSwipeIndicator();
    var pill = document.getElementById("pcp-health-swipe-pill");
    if (!pill) return;
    if (distance <= 0) {
      wrap.style.opacity = "0";
      wrap.style.transform = "translateX(0)";
      return;
    }
    var ready = distance >= SWIPE_THRESHOLD;
    pill.style.background = ready ? "#2563eb" : "#fff";
    pill.style.color = ready ? "#fff" : "#525252";
    pill.style.borderColor = ready ? "#2563eb" : "#e5e5e5";
    pill.textContent = ready ? syncMsg("release") : syncMsg("pull");
    wrap.style.opacity = "1";
    wrap.style.transform = "translateX(-" + Math.min(distance, SWIPE_THRESHOLD) * 0.22 + "px)";
  }

  function installSwipeLeftSync() {
    if (window.__pcpHealthSwipeLeft) return;
    window.__pcpHealthSwipeLeft = true;
    var active = false;
    var startX = 0;
    var startY = 0;
    var swipe = 0;

    function resetSwipe() {
      active = false;
      swipe = 0;
      updateSwipeIndicator(0);
    }

    document.addEventListener(
      "touchstart",
      function (e) {
        if (!isPatientHome()) return;
        if (e.touches.length !== 1) return;
        if (insideNestedScroller(e.target)) return;
        active = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      },
      { passive: true }
    );

    document.addEventListener(
      "touchmove",
      function (e) {
        if (!active) return;
        var dx = e.touches[0].clientX - startX;
        var dy = e.touches[0].clientY - startY;
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > VERTICAL_CANCEL) {
          resetSwipe();
          return;
        }
        if (dx >= 0) {
          resetSwipe();
          return;
        }
        swipe = Math.min(SWIPE_MAX, -dx * 0.55);
        updateSwipeIndicator(swipe);
      },
      { passive: true }
    );

    document.addEventListener(
      "touchend",
      function () {
        if (!active) return;
        var swiped = swipe;
        resetSwipe();
        if (swiped < SWIPE_THRESHOLD) return;
        var b = bridge();
        if (
          window.__pcpHealthBackfillRunning === true ||
          (b && b.isBackfillRunning && b.isBackfillRunning())
        ) {
          showSyncToast(syncMsg("backfill_blocked"), { warn: true });
          return;
        }
        wrapTriggerSync();
        runManualHealthSync();
      },
      { passive: true }
    );

    document.addEventListener("touchcancel", resetSwipe, { passive: true });
  }

  function boot() {
    if (!isAndroidApp()) return;
    dismissSyncToast();
    resolveSyncAuthToken().then(function (token) {
      if (!token) return;
      return hydrateSyncState(token).then(function () {
        syncBackfillBanner();
      });
    });
    wrapTriggerSync();
    installSwipeLeftSync();
    window.tryShowSwipeCoachAfterAuth = tryShowSwipeCoachAfterAuth;
    window.schedulePcpBackgroundHealthSync = scheduleBackgroundAutoSync;
    window.addEventListener("pcp-health-authorized", function () {
      tryShowSwipeCoachAfterAuth();
      scheduleBackgroundAutoSync();
    });
    window.addEventListener("pcp-health-backfill-started", function () {
      window.__pcpHealthBackfillRunning = true;
      showBackfillBanner();
      resolveSyncAuthToken().then(function (token) {
        if (token) pollBackfillUntilDone(token, { emitStart: false, emitFinish: false });
      });
    });
    window.addEventListener("pcp-health-backfill-finished", function (ev) {
      var d = (ev && ev.detail) || {};
      window.__pcpHealthBackfillRunning = false;
      __pcpBackfillPollActive = false;
      if (d.ok === false) {
        showBackfillBanner({ forceError: true });
        return;
      }
      hideBackfillBanner(false);
      if (window.PcpHealthDisplayRefresh && window.PcpHealthDisplayRefresh.scheduleRefreshAfterSync) {
        window.PcpHealthDisplayRefresh.scheduleRefreshAfterSync({
          reason: "backfill-complete",
          pulse: true,
          retryMs: [800, 2500],
        });
      }
    });
    window.addEventListener("pcp-health-sync-finished", function (ev) {
      var d = (ev && ev.detail) || {};
      syncBackfillBanner();
      if (d.backfillPending && isBackfillUiActive()) {
        resolveSyncAuthToken().then(function (token) {
          if (token) pollBackfillUntilDone(token, { emitStart: false, emitFinish: false });
        });
      }
    });
    window.addEventListener("pcp-health-sync-started", function (ev) {
      var d = (ev && ev.detail) || {};
      if (!d.manual) return;
      showSyncToast(syncMsg("syncing"), { persist: true });
      showLogSharePrompt();
    });
    window.addEventListener("pcp-health-sync-finished", function (ev) {
      var d = (ev && ev.detail) || {};
      if (!d.manual) return;
      if (d.skipped && d.reason === "busy") {
        showSyncToast(syncMsg("error_busy"), { warn: true });
        showLogSharePrompt();
        return;
      }
      if (d.skipped && d.reason === "backfill_running") {
        showSyncToast(syncMsg("backfill_blocked"), { warn: true });
        return;
      }
      if (d.ok === true && !d.skipped) {
        dismissSyncToast();
        if (!d.backfillPending) {
          showSyncToast(syncMsg("success"));
        }
        dismissCoach(true);
        showLogSharePrompt();
        return;
      }
      if (d.empty || d.reason === "no_data") {
        dismissSyncToast();
        showSyncToast(formatEmptySync(parseSyncInfo()), { warn: true });
        showLogSharePrompt();
        return;
      }
      if (d.reason === "timeout") {
        showSyncToast(syncMsg("syncing"), { warn: true });
        return;
      }
      if (d.ok === false && d.reason === "auth_expired") {
        showSyncToast(syncMsg("error_session"), { error: true });
        return;
      }
      if (d.ok === false) {
        dismissSyncToast();
        showSyncToast(formatSyncError(d.info || parseSyncInfo()), { error: true });
        showLogSharePrompt();
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        if (!__pcpManualSyncLock) dismissSyncToast();
        syncBackfillBanner();
        if (Date.now() - __pcpSessionBootAt > 800 && isPatientHome()) {
          scheduleBackgroundAutoSync();
        }
      } else if (__pcpAutoSyncTimer) {
        clearTimeout(__pcpAutoSyncTimer);
        __pcpAutoSyncTimer = null;
      }
    });
    if (isPatientHome()) {
      setTimeout(function () {
        showCoachIfAuthorized();
      }, 2500);
    }
    if (isPatientHome()) {
      setTimeout(scheduleBackgroundAutoSync, AUTO_SYNC_DEFER_MS + 500);
    }
  }

  boot();
  setInterval(wrapTriggerSync, 2000);
})();
