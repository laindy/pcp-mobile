/**
 * Sync HealthKit → POST /api/v1/patients/me/health/sync (iOS).
 * Chargé automatiquement par le hook natif après login + permissions.
 */
(function () {
  const SYNC_CONST = window.PcpHealthSyncConstants || {};
  const SYNC_ENDPOINT = "/api/v1/patients/me/health/sync";
  /** Agrégats journaliers + probe serveur — 1 an. */
  const DAILY_AGGREGATE_LOOKBACK_DAYS =
    SYNC_CONST.DAILY_AGGREGATE_LOOKBACK_DAYS ?? 365;
  /** Samples intraday scoring (vitaux, sommeil stades, FC séance) — 90 j. */
  const SAMPLE_INTRADAY_LOOKBACK_DAYS =
    SYNC_CONST.SAMPLE_INTRADAY_LOOKBACK_DAYS ?? 90;
  /** Ancienne fenêtre — réparation 1× gap j 61–90 pour comptes backfillés à 60 j. */
  const PREVIOUS_INTRADAY_LOOKBACK_DAYS =
    SYNC_CONST.PREVIOUS_INTRADAY_LOOKBACK_DAYS ?? 60;
  /** Alias logs / probe (journalier). */
  const FULL_LOOKBACK_DAYS = DAILY_AGGREGATE_LOOKBACK_DAYS;
  const LOOKBACK_DAYS = FULL_LOOKBACK_DAYS;
  const WORKOUT_LOOKBACK_DAYS = SYNC_CONST.WORKOUT_LOOKBACK_DAYS ?? DAILY_AGGREGATE_LOOKBACK_DAYS;
  /** 1ère sync : fenêtre prioritaire pour débloquer l'UI vite. */
  const PRIORITY_LOOKBACK_DAYS = SYNC_CONST.PRIORITY_LOOKBACK_DAYS ?? 7;
  const RECENT_ACTIVITY_REPAIR_DAYS = SYNC_CONST.RECENT_ACTIVITY_REPAIR_DAYS ?? PRIORITY_LOOKBACK_DAYS + 7;
  /** Syncs suivantes : delta court + recouvrement Apple Santé. */
  const INCREMENTAL_LOOKBACK_HOURS = 48;
  const INCREMENTAL_OVERLAP_HOURS = 24;
  const FULL_BACKFILL_KEY = "pcpHealthFullBackfillAt";
  const BACKFILL_PENDING_KEY = "pcpHealthBackfillPending";
  /** Tranches 10 j intraday (j 8–90) validées — reprise sans re-télécharger tout. */
  const HISTORICAL_CHECKPOINT_KEY = "pcpHealthHistoricalCheckpoint";
  /** Tranches 30 j agrégats journaliers (j 91–365) — reprise backfill 1 an. */
  const DAILY_EXTENDED_CHECKPOINT_KEY = "pcpHealthDailyExtendedCheckpoint";
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;
  const SAMPLE_PAGE_SIZE = 500;
  const SAMPLE_PAGE_SIZE_HIGH = 1000;
  const WORKOUT_PAGE_SIZE = 500;
  const MAX_SAMPLE_PAGES = 300;
  const MAX_SLEEP_SAMPLE_PAGES = 400;
  const MAX_WORKOUT_PAGES = 40;
  const HIGH_VOLUME_SAMPLE_TYPES = new Set([
    "heartRateVariability",
    "respiratoryRate",
    "oxygenSaturation",
    "sleep",
  ]);
  /**
   * Capgo tronque souvent à ~1000 samples — tranches calendaires 60j lues en parallèle.
   * Vitaux denses uniquement (pas FC continue : non affichée, TRIMP = fallback calories).
   */
  const DATE_CHUNK_READ_TYPES = new Set([
    "heartRateVariability",
    "respiratoryRate",
    "oxygenSaturation",
  ]);
  const DATE_CHUNK_DAYS = SYNC_CONST.SAMPLE_HISTORICAL_SLICE_DAYS ?? 10;
  const DAILY_EXTENDED_SLICE_DAYS = SYNC_CONST.DAILY_EXTENDED_SLICE_DAYS ?? 30;
  /** Lectures HealthKit en parallèle (types et tranches). */
  const READ_CONCURRENCY = 5;
  const CHUNK_READ_CONCURRENCY = 4;
  const MIN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
  /** Délai entre appels Capgo — 0 = lecture max rapide (HealthKit sérialise côté natif). */
  const READ_STAGGER_MS = 0;
  /** WKWebView : limite haute pour les types peu denses (rollup backend coûteux par lot). */
  const MAX_SYNC_POST_BYTES = 512 * 1024;
  /** Types denses (Apple Watch) : lots ≤380 KB — évite Load failed WKWebView (~896 KB). */
  const DENSE_STREAM_POST_TYPES = new Set([
    "heartRateVariability",
    "respiratoryRate",
    "oxygenSaturation",
    "sleep",
  ]);
  const MAX_DENSE_STREAM_POST_BYTES = 380 * 1024;
  const MAX_DENSE_STREAM_SAMPLES = 2500;
  const SYNC_POST_MAX_RETRIES = 2;
  const SYNC_POST_RETRY_MS = 1200;
  /** Dernière sync ayant réellement envoyé des samples/workouts au backend. */
  const LAST_DATA_SYNC_KEY = "pcpHealthLastDataSyncAt";
  const AGGREGATES_BACKFILL_KEY = "pcpHealthAggregatesV8";
  /** Réparation 1× des steps_total effacés après backfill compact (post-fix scoring steps). */
  const STEPS_REPAIR_KEY = "pcpHealthStepsRepairV2";
  /** Réparation 1× énergie/effort récents — kcal agrégats + samples |agg| (14 j). */
  const ACTIVITY_CALORIES_REPAIR_KEY = "pcpHealthActivityCaloriesRepairV1";
  /** Réparation 1× des stades sommeil historiques (j 8–90) pour constance / réparateur. */
  const SLEEP_STAGES_REPAIR_KEY = "pcpHealthSleepStagesRepairV2";
  const SLEEP_STAGES_REPAIR_ATTEMPTS_KEY = "pcpHealthSleepStagesRepairAttemptsV2";
  const SLEEP_STAGES_REPAIR_MAX_ATTEMPTS = 2;
  const SLEEP_STAGES_GAP_BATCH_DAYS = 14;
  /** Réparation 1× sommeil + workouts + vitaux en daily-extended (j 91–365). */
  const DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY = "pcpHealthDailyExtendedSleepWorkoutRepairV2";
  /** Réparation 1× intraday scoring j 61–90 (migration 60 → 90 j). */
  const SCORING_90D_REPAIR_KEY = "pcpHealthScoring90dRepairV1";
  /** Réparation 1× recovery j 8–90 : re-envoi vitaux nocturnes pour rescoring backend. */
  const RECOVERY_RESCORE_REPAIR_KEY = "pcpHealthRecoveryRescoreRepairV4";
  const RECOVERY_RESCORE_SLICE_DAYS = 21;
  /** Dernier patient dont l'état sync (backfill / incrémental) a été lu. */
  const SYNC_SCOPE_PATIENT_KEY = "pcpHealthSyncScopePatientId";
  const SYNC_STUCK_RESET_MS = 12 * 60 * 1000;
  const BACKFILL_STUCK_RESET_MS = 30 * 60 * 1000;
  /** Survit au reload WKWebView (UserDefaults iOS, aligné TokenStore Android). */
  const NATIVE_PERSIST_KEYS = new Set([
    FULL_BACKFILL_KEY,
    LAST_DATA_SYNC_KEY,
    BACKFILL_PENDING_KEY,
    HISTORICAL_CHECKPOINT_KEY,
    DAILY_EXTENDED_CHECKPOINT_KEY,
    AGGREGATES_BACKFILL_KEY,
    STEPS_REPAIR_KEY,
    ACTIVITY_CALORIES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_ATTEMPTS_KEY,
    DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY,
    SCORING_90D_REPAIR_KEY,
    RECOVERY_RESCORE_REPAIR_KEY,
  ]);
  const NATIVE_TS_KEYS = new Set([
    FULL_BACKFILL_KEY,
    LAST_DATA_SYNC_KEY,
    STEPS_REPAIR_KEY,
    ACTIVITY_CALORIES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_ATTEMPTS_KEY,
    DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY,
    SCORING_90D_REPAIR_KEY,
    RECOVERY_RESCORE_REPAIR_KEY,
  ]);

  function patientIdFromAccessToken(token) {
    if (!token || typeof token !== "string") return "";
    try {
      const payload = token.split(".")[1];
      if (!payload) return "";
      const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return typeof json.sub === "string" ? json.sub : "";
    } catch (_) {
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
    const pid = patientId || resolveSyncPatientId("");
    return pid ? `${baseKey}:${pid}` : baseKey;
  }

  function persistSyncKeyToNative(baseKey, value, token) {
    const pid = resolveSyncPatientId(token);
    if (!pid || !NATIVE_PERSIST_KEYS.has(baseKey)) return;
    try {
      const bridge = window.PcpHealthBridge;
      if (bridge?.setSyncScopedState) {
        bridge.setSyncScopedState(pid, baseKey, value == null ? "" : String(value));
      }
    } catch (_) {}
  }

  function getSyncScopedItem(baseKey, token) {
    return sessionStorage.getItem(scopedSyncKey(baseKey, resolveSyncPatientId(token)));
  }

  function setSyncScopedItem(baseKey, value, token) {
    const pid = resolveSyncPatientId(token);
    if (pid) {
      sessionStorage.setItem(SYNC_SCOPE_PATIENT_KEY, pid);
      window.__pcpHealthSyncPatientId = pid;
    }
    sessionStorage.setItem(scopedSyncKey(baseKey, pid), value);
    persistSyncKeyToNative(baseKey, value, token);
  }

  async function hydrateSyncStateFromNative(token) {
    const pid = resolveSyncPatientId(token);
    if (!pid) return { hydrated: false };
    const bridge = window.PcpHealthBridge;
    if (!bridge?.getSyncScopedState) return { hydrated: false };
    let native;
    try {
      native = await bridge.getSyncScopedState(pid);
    } catch (_) {
      return { hydrated: false };
    }
    if (!native || typeof native !== "object") return { hydrated: false };
    let merged = 0;
    for (const baseKey of NATIVE_PERSIST_KEYS) {
      const raw = native[baseKey];
      if (raw == null || raw === "") continue;
      const scoped = scopedSyncKey(baseKey, pid);
      const sessionVal = sessionStorage.getItem(scoped);
      if (!sessionVal) {
        sessionStorage.setItem(scoped, String(raw));
        merged += 1;
        continue;
      }
      if (NATIVE_TS_KEYS.has(baseKey)) {
        const n = parseInt(raw, 10);
        const s = parseInt(sessionVal, 10);
        if (Number.isFinite(n) && n > 0 && (!Number.isFinite(s) || n > s)) {
          sessionStorage.setItem(scoped, String(n));
          merged += 1;
        }
      }
    }
    for (const baseKey of NATIVE_PERSIST_KEYS) {
      const sessionVal = sessionStorage.getItem(scopedSyncKey(baseKey, pid));
      if (sessionVal) persistSyncKeyToNative(baseKey, sessionVal, token);
    }
    if (merged > 0) {
      log(`État sync restauré depuis stockage natif (${merged} clé(s))`);
    }
    reconcileLocalBackfillState(token);
    return { hydrated: merged > 0, merged };
  }

  /** Corrige pending / fullBackfill désynchronisés (reload WKWebView, skip serveur partiel). */
  function reconcileLocalBackfillState(token) {
    const fullAt = parseInt(getSyncScopedItem(FULL_BACKFILL_KEY, token) || "0", 10);
    const pending = getSyncScopedItem(BACKFILL_PENDING_KEY, token) === "1";
    if (fullAt > 0 && pending) {
      setHistoricalBackfillPending(token, false);
      log("État sync réconcilié — backfill terminé, pending obsolète effacé");
      return { reconciled: true, reason: "stale_pending" };
    }
    let skipMeta = null;
    try {
      const raw = sessionStorage.getItem("pcpHealthBackfillSkipMeta");
      if (raw) skipMeta = JSON.parse(raw);
    } catch (_) {}
    if (skipMeta?.at && fullAt <= 0) {
      setSyncScopedItem(FULL_BACKFILL_KEY, String(skipMeta.at), token);
      setHistoricalBackfillPending(token, false);
      log(
        `État sync réconcilié depuis probe serveur (${skipMeta.daysWithData ?? "?"}j signal, span=${skipMeta.spanDays ?? "?"})`,
      );
      return { reconciled: true, reason: "skip_meta" };
    }
    return { reconciled: false };
  }

  /** Backfill 53 j (phase historical) en cours ou interrompu — pas encore marqué terminé. */
  function isHistoricalBackfillPending(token) {
    return (
      window.__pcpHealthBackfillRunning === true ||
      getSyncScopedItem(BACKFILL_PENDING_KEY, token) === "1"
    );
  }

  function isFullBackfillComplete(token) {
    return parseInt(getSyncScopedItem(FULL_BACKFILL_KEY, token) || "0", 10) > 0;
  }

  function getLastDataSyncAt(token) {
    return parseInt(getSyncScopedItem(LAST_DATA_SYNC_KEY, token) || "0", 10) || 0;
  }

  /** Adaptateur stockage pour PcpHealthServerBackfillProbe (parité Android hook). */
  function buildServerProbeStorage(token, overrides = {}) {
    return {
      isFullBackfillComplete: () => isFullBackfillComplete(token),
      isBackfillPending: () => isHistoricalBackfillPending(token),
      setFullBackfillComplete: (ts) =>
        setSyncScopedItem(FULL_BACKFILL_KEY, String(ts || Date.now()), token),
      clearBackfillPending: () => setHistoricalBackfillPending(token, false),
      getLastDataSyncAt: () => getLastDataSyncAt(token),
      log,
      sessionLog: (line) => log(line),
      ...overrides,
    };
  }

  function setHistoricalBackfillPending(token, pending) {
    const pid = resolveSyncPatientId(token);
    const key = scopedSyncKey(BACKFILL_PENDING_KEY, pid);
    if (pending) {
      setSyncScopedItem(BACKFILL_PENDING_KEY, "1", token);
    } else {
      try {
        sessionStorage.removeItem(key);
      } catch (_) {}
      persistSyncKeyToNative(BACKFILL_PENDING_KEY, "", token);
    }
  }

  /** État sync (backfill 60 j vs incrémental) isolé par compte patient sur le même appareil. */
  function ensureSyncPatientScope(token) {
    const pid = resolveSyncPatientId(token);
    if (!pid) return null;
    const prev = sessionStorage.getItem(SYNC_SCOPE_PATIENT_KEY);
    if (prev && prev !== pid) {
      log(
        `Compte patient changé — backfill ${FULL_LOOKBACK_DAYS}j requis pour ce compte (état sync par patient)`,
      );
      try {
        if (window.PcpHealthDisplayRefresh?.invalidateHealthQueries) {
          void window.PcpHealthDisplayRefresh.invalidateHealthQueries();
        }
      } catch (_) {}
    }
    sessionStorage.setItem(SYNC_SCOPE_PATIENT_KEY, pid);
    window.__pcpHealthSyncPatientId = pid;
    return pid;
  }

  /**
   * Types lus / autorisés — alignés frontend + backend (scores, vitaux, workouts).
   * Exclus : FC 24/7, distance, glycémie, tension, poids/taille, etc.
   * VO₂ max = lecture native (hors Capgo). Temp. poignet = fetchAllTemperatureSamples.
   */
  const HEALTH_READ_PERMS = [
    "steps",
    "calories",
    "sleep",
    "respiratoryRate",
    "oxygenSaturation",
    "restingHeartRate",
    "heartRateVariability",
    "bodyTemperature",
    "basalBodyTemperature",
    "heartRate",
    "mindfulness",
    "workouts",
  ];

  const HEALTH_AUTH_PERMS = { read: HEALTH_READ_PERMS, write: [] };

  window.__pcpVo2MaxCallbacks = window.__pcpVo2MaxCallbacks || {};
  if (typeof window.__pcpVo2MaxResolve !== "function") {
    window.__pcpVo2MaxResolve = function (requestId, payload) {
      const cb = window.__pcpVo2MaxCallbacks?.[requestId];
      if (cb) {
        delete window.__pcpVo2MaxCallbacks[requestId];
        cb(payload);
      }
    };
  }

  window.__pcpWorkoutsCallbacks = window.__pcpWorkoutsCallbacks || {};
  if (typeof window.__pcpWorkoutsResolve !== "function") {
    window.__pcpWorkoutsResolve = function (requestId, payload) {
      const cb = window.__pcpWorkoutsCallbacks?.[requestId];
      if (cb) {
        delete window.__pcpWorkoutsCallbacks[requestId];
        cb(payload);
      }
    };
  }

  async function countHealthReadAuthorized(Health) {
    const status = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    return status?.readAuthorized?.length ?? 0;
  }

  /**
   * Sync manuelle uniquement : si aucun type autorisé, rouvre la feuille Santé iOS.
   * Exposé sur PcpHealthIosSync pour être appelé depuis triggerSync (proche du geste).
   */
  async function requestHealthAuthForManualSync() {
    const Health = window.Capacitor?.Plugins?.Health;
    if (!Health) return { granted: 0, error: "no_plugin" };

    const avail = await Health.isAvailable();
    if (!avail?.available) {
      log(`HealthKit indisponible: ${avail?.reason ?? "unknown"}`);
      return { granted: 0, error: "unavailable" };
    }

    if (typeof window.ensureHealthKitReadAccess === "function") {
      const auth = await window.ensureHealthKitReadAccess(Health, { force: true, manual: true });
      if (auth.granted > 0) {
        try {
          localStorage.setItem("pcpHealthAuthGrantedOnce", "1");
        } catch (_) {}
      } else {
        try {
          localStorage.removeItem("pcpHealthAuthGrantedOnce");
        } catch (_) {}
      }
      if (auth.requested && auth.granted > 0) {
        try {
          window.dispatchEvent(
            new CustomEvent("pcp-health-authorized", { detail: { granted: auth.granted } }),
          );
        } catch (_) {}
      }
      return {
        granted: auth.granted || 0,
        requestedAuth: !!auth.requested,
        cancelled: !!auth.cancelled,
      };
    }

    const before = await countHealthReadAuthorized(Health);
    if (before > 0) {
      return { granted: before };
    }

    if (typeof window.showPcpHealthPreAuthModal === "function") {
      const proceed = await window.showPcpHealthPreAuthModal({ ignoreSeen: true });
      if (!proceed) {
        log("Sync manuelle annulée — explication Santé refusée");
        return { granted: 0, cancelled: true };
      }
    }

    log("Sync manuelle — ouverture feuille autorisation Santé…");
    await Health.requestAuthorization(HEALTH_AUTH_PERMS);
    await new Promise((resolve) => setTimeout(resolve, 800));
    let granted = await countHealthReadAuthorized(Health);
    if (granted > 0 && before === 0) {
      try {
        window.dispatchEvent(
          new CustomEvent("pcp-health-authorized", { detail: { granted } }),
        );
      } catch (_) {}
    }
    return { granted, requestedAuth: true };
  }

  /** Métriques affichées côté web — utilisées pour les logs Xcode. */
  const UI_METRICS = [
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

  function sampleCountForType(samplesByType, type) {
    const block = samplesByType?.[type];
    if (!block) return 0;
    if (typeof block.sample_count === "number") return block.sample_count;
    return Array.isArray(block.samples) ? block.samples.length : 0;
  }

  function logOutboundSummary(payload, sentSamples, sentWorkouts, sentAggregates) {
    log("──── HealthKit → POST /health/sync (envoi) ────");
    for (const m of UI_METRICS) {
      if (m.isWorkout) {
        log(`  ${m.label.padEnd(14)} workouts  envoyés=${sentWorkouts}`);
        continue;
      }
      const n = sampleCountForType(payload.samples_by_type, m.type);
      const flag = n > 0 ? "✓" : "○";
      log(`  ${flag} ${m.label.padEnd(12)} ${m.type.padEnd(22)} samples=${n}`);
    }
    const todayAgg = (payload.daily_aggregates || [])[payload.daily_aggregates.length - 1];
    if (todayAgg) {
      log(`  Agrégats: ${sentAggregates} jour(s) — dernier jour ${todayAgg.day}`);
      for (const m of UI_METRICS) {
        if (!m.dailyField || todayAgg[m.dailyField] == null) continue;
        log(`      · ${m.label}: ${todayAgg[m.dailyField]}`);
      }
    } else {
      log(`  Agrégats journaliers: ${sentAggregates}`);
    }
    log(`  Total samples=${sentSamples} | sync_id=${payload.sync_id}`);
    const sleepSamples = payload.samples_by_type?.sleep?.samples;
    if (Array.isArray(sleepSamples) && sleepSamples.length > 0) {
      logSleepSegmentSummary(sleepSamples, "  sleep stades (payload POST)", payload.daily_aggregates);
    }
    logVo2PayloadSummary(payload.samples_by_type?.vo2Max?.samples);
  }

  function isNonSleepStageToken(stageName) {
    const n = String(stageName ?? "")
      .toLowerCase()
      .replace(/_/g, "");
    return (
      n.includes("awake") ||
      n.includes("inbed") ||
      n.includes("outofbed") ||
      n.includes("in_bed")
    );
  }

  function isRestorativeSleepStage(stageName) {
    const n = String(stageName ?? "")
      .toLowerCase()
      .replace(/_/g, "");
    return n.includes("rem") || n.includes("deep");
  }

  /** Durée endormi = union des intervalles (évite double comptage stades chevauchants). */
  function sleepMergedMinutesFromSegments(segments, filterFn) {
    const intervals = [];
    for (const s of segments ?? []) {
      if (filterFn && !filterFn(s)) continue;
      if (isNonSleepStageToken(s.stage)) continue;
      const startMs = new Date(s.startDate).getTime();
      const endMs = new Date(s.endDate).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        intervals.push({ startMs, endMs });
      }
    }
    return mergedIntervalMs(intervals) / 60000;
  }

  /** Agrège segments normalisés par type de stage (contrat v1). */
  function summarizeSleepSegments(segments) {
    const stageCounts = new Map();
    const stageMins = new Map();
    let withStage = 0;
    for (const s of segments) {
      if (!s) continue;
      const st = s.stage != null && String(s.stage).length > 0 ? String(s.stage) : "(sans stage)";
      if (s.stage) withStage += 1;
      stageCounts.set(st, (stageCounts.get(st) || 0) + 1);
      const mins = Number(s.value);
      if (Number.isFinite(mins) && mins > 0) {
        stageMins.set(st, (stageMins.get(st) || 0) + mins);
      }
    }
    return { stageCounts, stageMins, withStage, total: segments.length };
  }

  /** Logs détaillés stades — lecture HK ou payload POST. */
  function logSleepSegmentSummary(segments, title, dailyRows) {
    if (!Array.isArray(segments) || segments.length === 0) {
      log(`${title}: aucun segment`);
      return;
    }
    const { stageCounts, stageMins, withStage, total } = summarizeSleepSegments(segments);
    log(`${title}: ${withStage}/${total} segment(s) avec stage (sommes par type ≠ durée totale)`);
    const sorted = [...stageMins.entries()].sort((a, b) => b[1] - a[1]);
    for (const [stage, mins] of sorted.slice(0, 10)) {
      const n = stageCounts.get(stage) || 0;
      log(`      · ${stage}: ${Math.round(mins)} min (${n} seg.)`);
    }
    if (sorted.length > 10) {
      log(`      · … +${sorted.length - 10} autre(s) type(s) de stage`);
    }

    let latestEndMs = 0;
    for (const s of segments) {
      const t = new Date(s.endDate).getTime();
      if (Number.isFinite(t) && t > latestEndMs) latestEndMs = t;
    }
    if (latestEndMs <= 0) return;

    const wakeDay = localDayKey(new Date(latestEndMs).toISOString());
    const windowStart = latestEndMs - 16 * 60 * 60 * 1000;
    const nightSegs = segments.filter((s) => {
      const endMs = new Date(s.endDate).getTime();
      return Number.isFinite(endMs) && endMs >= windowStart && endMs <= latestEndMs + 60_000;
    });
    if (nightSegs.length === 0) return;

    const mergedAsleepMin = sleepMergedMinutesFromSegments(nightSegs);
    const mergedRestorativeMin = sleepMergedMinutesFromSegments(nightSegs, (s) =>
      isRestorativeSleepStage(s.stage),
    );
    const aggRow = Array.isArray(dailyRows)
      ? dailyRows.find((r) => r?.day === wakeDay) ??
        dailyRows.reduce((best, r) => (!best || String(r?.day) > String(best.day) ? r : best), null)
      : null;
    const totalMin =
      aggRow?.sleep_total_min != null && aggRow.sleep_total_min > 0
        ? Math.round(aggRow.sleep_total_min)
        : Math.round(mergedAsleepMin);
    const totalNote = aggRow?.sleep_total_min != null ? "total Santé (agrégat)" : "intervalles fusionnés";
    log(
      `      · dernière nuit (réveil ${wakeDay}): ${totalMin} min endormi (${totalNote}), REM+Deep ~${Math.round(mergedRestorativeMin)} min (${nightSegs.length} seg. bruts)`,
    );
  }

  function logSyncPostResponse(body) {
    log("──── Réponse backend (POST sync) ────");
    log(
      `  batch=${body.sync_batch_id ?? "?"} | samples reçus=${body.samples_received ?? "?"} insérés=${body.samples_inserted ?? "?"} doublons=${body.samples_skipped ?? "?"}`,
    );
    log(
      `  workouts reçus=${body.workouts_received ?? "?"} insérés=${body.workouts_inserted ?? "?"} doublons=${body.workouts_skipped ?? "?"}`,
    );
    log(
      `  agrégats reçus=${body.aggregates_received ?? "?"} insérés=${body.aggregates_inserted ?? "?"}`,
    );
  }

  async function verifyBackendStorage(token, sentWorkoutsThisSync) {
    log("──── Vérification lecture backend (GET) ────");
    const headers = { Authorization: `Bearer ${token}` };

    let dailyLatest = null;
    try {
      const dailyRes = await fetch("/api/v1/patients/me/health/daily?limit=1", {
        headers,
        cache: "no-store",
      });
      if (dailyRes.ok) {
        const dailyList = await dailyRes.json();
        dailyLatest = Array.isArray(dailyList) && dailyList.length > 0 ? dailyList[0] : null;
        if (dailyLatest) {
          log(
            `  Daily ${dailyLatest.day}: pas=${dailyLatest.steps_total ?? "—"} cal=${dailyLatest.calories_total_kcal ?? "—"} sommeil_min=${dailyLatest.sleep_total_min ?? "—"} dist_m=${dailyLatest.distance_total_m ?? "—"} hrv=${dailyLatest.hrv_avg_ms ?? "—"} fc_repos=${dailyLatest.resting_heart_rate_avg ?? "—"} resp=${dailyLatest.respiratory_rate_avg ?? "—"} spo2=${dailyLatest.oxygen_saturation_avg ?? "—"} effort=${dailyLatest.effort_score ?? "—"}`,
          );
          await logEffortDayDiagnostics(token, dailyLatest);
          await logSleepStageDiagnostics(token, dailyLatest);
          await logVo2Diagnostics(token);
        } else {
          log("  Daily: aucune ligne en base");
        }
      } else {
        log(`  Daily: HTTP ${dailyRes.status}`);
      }
    } catch (e) {
      log(`  Daily: ${formatSyncError(e, "GET daily")}`);
    }

    let vitals = null;
    try {
      const vitalsRes = await fetch("/api/v1/patients/me/health/vitals/latest", {
        headers,
        cache: "no-store",
      });
      if (vitalsRes.ok) {
        vitals = await vitalsRes.json();
      }
    } catch (e) {
      log(`  Vitals: ${formatSyncError(e, "GET vitals")}`);
    }

    for (const m of UI_METRICS) {
      if (m.isWorkout) {
        try {
          const res = await fetch("/api/v1/patients/me/health/workouts?page_size=1", {
            headers,
            cache: "no-store",
          });
          if (!res.ok) {
            log(`  ○ ${m.label.padEnd(12)} HTTP ${res.status}`);
            continue;
          }
          const page = await res.json();
          const total = page.total ?? 0;
          const latest = page.items?.[0];
          const detail = latest
            ? `${latest.workout_type} @ ${latest.start_at}`
            : "—";
          log(
            `  ${total > 0 ? "✓" : "○"} ${m.label.padEnd(12)} cette sync=${sentWorkoutsThisSync ?? 0} | total en base=${total}  dernier=${detail}`,
          );
        } catch (e) {
          log(`  ○ ${m.label.padEnd(12)} ${formatSyncError(e, "GET workouts")}`);
        }
        continue;
      }

      try {
        const res = await fetch(
          `/api/v1/patients/me/health/samples?data_type=${encodeURIComponent(m.type)}&page_size=1`,
          { headers, cache: "no-store" },
        );
        if (!res.ok) {
          log(`  ○ ${m.label.padEnd(12)} ${m.type.padEnd(22)} HTTP ${res.status}`);
          continue;
        }
        const page = await res.json();
        const total = page.total ?? 0;
        const latest = page.items?.[0];
        let detail = "—";
        if (latest) {
          detail = `${latest.value} ${latest.unit} @ ${latest.start_at}`;
          if (m.type === "sleep" && latest.extra?.stage) {
            detail += ` | stage=${latest.extra.stage}`;
          }
        }
        if (m.dailyField && dailyLatest?.[m.dailyField] != null) {
          detail += ` | agrégat=${dailyLatest[m.dailyField]}`;
        }
        if (m.vitalKey && vitals?.[m.vitalKey]?.value != null) {
          detail += ` | vital=${vitals[m.vitalKey].value}`;
        }
        if (
          m.dailyField &&
          dailyLatest?.[m.dailyField] == null &&
          m.vitalKey &&
          vitals?.[m.vitalKey]?.value != null
        ) {
          const at = vitals[m.vitalKey]?.recorded_at;
          detail += at
            ? ` | note: pas de mesure aujourd'hui (dernière @ ${at})`
            : ` | note: pas de mesure aujourd'hui (dernière en base)`;
        }
        if (m.type === "sleep" && total > 0 && latest && !latest.extra?.stage) {
          detail += " | note: sample sans extra.stage — app ancienne ou resync requis";
        }
        if (m.type === "bodyTemperature" && total === 0) {
          detail +=
            " | note: Santé → Sommeil → température poignet (Watch S8+, ~5 nuits)";
        }
        if (m.type === "vo2Max" && total === 0) {
          detail +=
            " | note: mesures éparses (Watch/cardio) — autoriser VO₂ max dans Santé";
        }
        log(
          `  ${total > 0 ? "✓" : "○"} ${m.label.padEnd(12)} ${m.type.padEnd(22)} total=${String(total).padStart(4)}  ${detail}`,
        );
      } catch (e) {
        log(`  ○ ${m.label.padEnd(12)} ${formatSyncError(e, `GET samples ${m.type}`)}`);
      }
    }
    log("──── Fin vérification backend ────");
  }

  /** VO₂ max — samples éparses (montre / tests cardio), pas d'agrégat journalier. */
  function logVo2PayloadSummary(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      log("  VO₂ max (payload POST): 0 sample — autoriser dans Santé + mesures Watch/cardio");
      return;
    }
    const sorted = [...samples].sort(
      (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime(),
    );
    const latest = sorted[0];
    let min = Infinity;
    let max = -Infinity;
    for (const s of samples) {
      const v = Number(s.value);
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    log(
      `  VO₂ max (payload POST): ${samples.length} sample(s) | dernier=${latest.value} ${latest.unit ?? "mL/min/kg"} @ ${latest.startDate}${samples.length > 1 && Number.isFinite(min) ? ` | plage ${Math.round(min * 10) / 10}–${Math.round(max * 10) / 10}` : ""}`,
    );
  }

  async function logVo2Diagnostics(token) {
    if (!token) return;
    try {
      const res = await fetch("/api/v1/patients/me/health/samples?data_type=vo2Max&page_size=50", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        log(`  VO₂ max en base: HTTP ${res.status}`);
        return;
      }
      const page = await res.json();
      const items = Array.isArray(page?.items) ? page.items : [];
      const total = page.total ?? items.length;
      if (items.length === 0) {
        log(
          `  VO₂ max en base: 0 sample (total=${total}) — Android: HC VO₂ | iOS: rebuild + autoriser VO₂ max dans Santé`,
        );
        return;
      }
      const sorted = [...items].sort(
        (a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime(),
      );
      const latest = sorted[0];
      let min = Infinity;
      let max = -Infinity;
      for (const s of items) {
        const v = Number(s.value);
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      log(
        `  VO₂ max en base: ${total} sample(s) | dernier=${latest.value} ${latest.unit} @ ${latest.start_at}${items.length > 1 && Number.isFinite(min) ? ` | fenêtre GET min–max=${Math.round(min * 10) / 10}–${Math.round(max * 10) / 10}` : ""}`,
      );
      for (const s of sorted.slice(0, 3)) {
        log(
          `      · ${s.value} ${s.unit} @ ${s.start_at}${s.source_name ? ` (${s.source_name})` : ""}`,
        );
      }
    } catch (e) {
      log(`  VO₂ max en base: ${formatSyncError(e, "GET vo2Max samples")}`);
    }
  }

  async function logSleepStageDiagnostics(token, dailyLatest) {
    const day = dailyLatest?.day;
    const ss = dailyLatest?.extra?.sleep_stages;
    if (ss && typeof ss === "object") {
      log(`  Sommeil stades ${day} (backend extra.sleep_stages):`);
      log(
        `    awake=${ss.awake_min ?? "—"} rem=${ss.rem_min ?? "—"} core=${ss.core_min ?? "—"} deep=${ss.deep_min ?? "—"} min`,
      );
      log(
        `    réparateur=${ss.restorative_min ?? "—"} min (${ss.restorative_pct != null ? `${ss.restorative_pct}%` : "—"})`,
      );
    } else if (day) {
      log(
        `  Sommeil stades ${day}: extra.sleep_stages absent — backend sans stades (prod pas à jour?) ou nuit sans segments stagés`,
      );
    }

    if (!token) return;
    try {
      const res = await fetch("/api/v1/patients/me/health/samples?data_type=sleep&page_size=20", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        log(`  Sommeil stades samples: HTTP ${res.status}`);
        return;
      }
      const page = await res.json();
      const items = Array.isArray(page?.items) ? page.items : [];
      const withStage = items.filter((s) => s?.extra?.stage);
      log(
        `  Sommeil stades en base: ${withStage.length}/${items.length} récent(s) avec extra.stage (total=${page.total ?? "?"})`,
      );
      for (const s of withStage.slice(0, 5)) {
        log(`      · stage=${s.extra.stage} ${s.value} ${s.unit} @ ${s.start_at}`);
      }
      if (items.length > 0 && withStage.length === 0) {
        log("      · note: aucun stage en base — rebuild app + resync complète requis");
      }
    } catch (e) {
      log(`  Sommeil stades samples: ${formatSyncError(e, "GET sleep samples")}`);
    }
  }

  /** Effort = score du jour civil ; seules les activités dont start_at tombe ce jour comptent (TRIMP). */
  async function logEffortDayDiagnostics(token, dailyLatest) {
    const day = dailyLatest?.day;
    if (!day || !token) return;
    const ed = dailyLatest?.extra?.scores?.effort;
    log(
      `  Effort ${day}: score=${dailyLatest.effort_score ?? "—"} (quotidien — autres jours exclus du calcul)`,
    );
    if (ed && typeof ed === "object") {
      const bits = [
        ed.source ? `source=${ed.source}` : null,
        ed.load_day != null ? `trimp_jour=${ed.load_day}` : null,
        ed.active_calories != null ? `kcal_actives=${ed.active_calories}` : null,
        ed.status ? `status=${ed.status}` : null,
      ].filter(Boolean);
      if (bits.length) log(`    ${bits.join(" ")}`);
    }
    try {
      const res = await fetch("/api/v1/patients/me/health/workouts?page_size=50", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        log(`  Effort activités: HTTP ${res.status}`);
        return;
      }
      const page = await res.json();
      const items = Array.isArray(page?.items) ? page.items : [];
      const onDay = [];
      let other = 0;
      for (const w of items) {
        const k = localDayKey(w.start_at);
        if (k === day) onDay.push(w);
        else if (k) other += 1;
      }
      log(`  Effort: ${onDay.length} activité(s) sur ${day} (comptées TRIMP) | ${other} autre(s) jour(s) ignorée(s)`);
      for (const w of onDay.slice(0, 6)) {
        const tag = w.validated_at ? "validée" : "à valider";
        log(`    · ${w.workout_type ?? "?"} @ ${w.start_at} (${tag})`);
      }
    } catch (e) {
      log(`  Effort activités: ${formatSyncError(e, "effort-workouts")}`);
    }
  }

  const SAMPLE_TYPES = [
    "steps",
    "calories",
    "sleep",
    "heartRateVariability",
    "respiratoryRate",
    "oxygenSaturation",
    "restingHeartRate",
    "mindfulness",
  ];

  /** Exécute fn sur items avec au plus `limit` appels simultanés. */
  async function runWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < items.length) {
        const i = nextIdx++;
        results[i] = await fn(items[i], i);
      }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
  }

  function log(msg) {
    try {
      const line = String(msg);
      console.log("[PcpHealth]", line);
      if (window.PcpHealthLogExport?.push) {
        window.PcpHealthLogExport.push(line);
      }
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pcpHealthLog) {
        window.webkit.messageHandlers.pcpHealthLog.postMessage(line);
      }
    } catch (_) {}
  }

  /** Détails exploitables pour « Load failed » (fetch WKWebView hors-ligne, timeout, etc.). */
  function formatSyncError(err, phase) {
    const parts = [];
    const name = err?.name ?? "Error";
    const msg = err?.message != null ? String(err.message) : String(err);
    parts.push(`${name}: ${msg}`);
    if (phase) parts.push(`phase=${phase}`);
    try {
      parts.push(`page=${location.pathname || "?"}`);
      parts.push(`online=${navigator.onLine === false ? "non" : "oui"}`);
      parts.push(`origin=${location.origin || "?"}`);
    } catch (_) {}
    if (msg === "Load failed" || name === "TypeError") {
      parts.push(
        "hint=échec réseau WebView (hors-ligne, proxy, certificat, requête annulée, body trop gros)",
      );
      parts.push(`endpoint=${SYNC_ENDPOINT}`);
    }
    if (err?.status != null) parts.push(`http=${err.status}`);
    if (err?.cause?.message) parts.push(`cause=${err.cause.message}`);
    const stack = err?.stack;
    if (stack) {
      parts.push(
        `stack=${String(stack)
          .split("\n")
          .slice(0, 3)
          .join(" ← ")}`,
      );
    }
    return parts.join(" | ");
  }

  function dedupe(arr) {
    return [...new Set(arr)];
  }

  function localDayKey(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Jour civil local (fuseau appareil) — borne haute pour les agrégats POSTés. */
  function localCalendarTodayKey() {
    return localDayKey(new Date().toISOString());
  }

  function isFutureScoreRingDay(dayKey) {
    const today = localCalendarTodayKey();
    return !!dayKey && !!today && dayKey > today;
  }

  function isVitalsOnlyPartialRow(row) {
    const steps = toNum(row?.steps_total);
    const kcal = toNum(row?.calories_total_kcal);
    const sleep = toNum(row?.sleep_total_min);
    const hasActivity = (steps != null && steps > 0) || (kcal != null && kcal > 0);
    const hasSleep = sleep != null && sleep > 0;
    return !hasActivity && !hasSleep;
  }

  /** Évite qu'un jour futur ou un aujourd'hui vitaux-seuls devienne GET /daily?limit=1. */
  function isPostableDailyAggregateRow(row) {
    const day = row?.day;
    if (!day) return false;
    if (isFutureScoreRingDay(day)) return false;
    const today = localCalendarTodayKey();
    if (day === today && isVitalsOnlyPartialRow(row)) return false;
    return true;
  }

  function filterDailyAggregatesForPost(rows) {
    return (rows ?? []).filter(isPostableDailyAggregateRow);
  }

  const NIGHT_VITAL_SAMPLE_TYPES = new Set([
    "heartRateVariability",
    "respiratoryRate",
    "oxygenSaturation",
    "bodyTemperature",
    "restingHeartRate",
  ]);

  function filterNightVitalSamplesForPost(samples, dataType) {
    if (!NIGHT_VITAL_SAMPLE_TYPES.has(dataType)) return samples ?? [];
    return (samples ?? []).filter((s) => {
      const wakeDay = vitalWakeDayFromIso(s.startDate);
      return wakeDay && !isFutureScoreRingDay(wakeDay);
    });
  }

  function sleepDayKeyFromSample(sample) {
    return localDayKey(sample?.endDate ?? sample?.startDate);
  }

  /** Jour civil représenté par un bucket queryAggregated (fin de bucket = minuit lendemain). */
  function aggregatedBucketDayKey(bucket) {
    const end = bucket?.endDate ?? bucket?.end_date;
    if (end) {
      const d = new Date(end);
      if (!Number.isNaN(d.getTime())) {
        d.setTime(d.getTime() - 1);
        const key = localDayKey(d.toISOString());
        if (key) return key;
      }
    }
    return localDayKey(bucket?.startDate ?? bucket?.endDate);
  }

  function stageIntervalMinutes(stage) {
    let mins = Number(stage?.durationMinutes);
    if (Number.isFinite(mins) && mins > 0) return mins;
    return intervalMinutes(stage);
  }

  function isInBedStageName(name) {
    const n = String(name || "").toLowerCase();
    return n.includes("inbed") || n.includes("in_bed");
  }

  function normalizeSleepToken(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/_/g, "")
      .replace(/\s+/g, "");
  }

  function isAsleepStageName(name) {
    const n = normalizeSleepToken(name);
    if (!n) return true;
    if (n.includes("awake") || isInBedStageName(n)) return false;
    return (
      n.includes("asleep") ||
      n.includes("rem") ||
      n.includes("deep") ||
      n.includes("core") ||
      n.includes("light") ||
      n === "sleeping" ||
      n.includes("asleepunspecified")
    );
  }

  function sleepSourcePriority(label) {
    const n = String(label || "").toLowerCase();
    if (n.includes("watch")) return 3;
    if (n.includes("iphone")) return 2;
    return 1;
  }

  const SLEEP_SESSION_GAP_MS = 4 * 60 * 60 * 1000;

  function clusterSleepRawIntoNights(rawList) {
    if (!rawList.length) return [];
    const sorted = [...rawList].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );
    const nights = [];
    let batch = [];
    for (const raw of sorted) {
      const t = new Date(raw.startDate).getTime();
      let prevEnd = 0;
      if (batch.length) {
        prevEnd = Math.max(
          ...batch.map((r) => new Date(r.endDate ?? r.startDate).getTime()),
        );
      }
      if (batch.length && t - prevEnd > SLEEP_SESSION_GAP_MS) {
        nights.push(batch);
        batch = [];
      }
      batch.push(raw);
    }
    if (batch.length) nights.push(batch);
    return nights;
  }

  /** Intervalles de sommeil depuis un sample Capgo brut (stages + value + start/end). */
  function extractSleepIntervalsFromRaw(raw) {
    const out = [];
    const stages = raw?.stages;
    if (Array.isArray(stages) && stages.length > 0) {
      for (const st of stages) {
        const name = st?.stage ?? st?.name ?? st?.sleepState;
        if (!isAsleepStageName(name)) continue;
        const iv = stageToInterval(st);
        if (iv) out.push(iv);
      }
      if (out.length > 0) return out;
    }
    const state = normalizeSleepToken(raw?.sleepState ?? raw?.sleep_state);
    if (state.includes("awake")) return out;
    if (isInBedStageName(state)) return out;
    if (!state || isAsleepStageName(state)) {
      const parent = sleepSampleInterval(raw);
      if (parent) out.push(parent);
    }
    return out;
  }

  function sleepRawDebugLine(raw) {
    const state = raw?.sleepState ?? raw?.sleep_state ?? "—";
    const st = Array.isArray(raw?.stages) ? raw.stages.length : 0;
    const mins = sleepMinutesFromSample(raw);
    return `state=${state} stages=${st} start=${raw?.startDate ?? "—"} end=${raw?.endDate ?? "—"} mins=${mins ?? "—"}`;
  }

  /**
   * Types supportés par queryAggregated (doc Capgo 8.6) :
   * steps, distance, calories, heartRate, weight, restingHeartRate.
   * Sommeil / HRV / respiration / SpO₂ = readSamples + agrégation client (comme Santé).
   */
  const STATISTICS_DAILY_SPECS = [
    { type: "steps", field: "steps_total", aggregation: "sum", intField: true },
    { type: "calories", field: "calories_total_kcal", aggregation: "sum" },
    { type: "restingHeartRate", field: "resting_heart_rate_avg", aggregation: "average" },
  ];

  /** Moyennes journalières depuis samples paginés (Capgo ne statistique pas ces types). */
  const VITAL_AVG_FIELDS = {
    heartRateVariability: "hrv_avg_ms",
    respiratoryRate: "respiratory_rate_avg",
    oxygenSaturation: "oxygen_saturation_avg",
    bodyTemperature: "body_temperature_avg",
  };

  const SUM_DAILY_FIELDS = {
    mindfulness: "mindfulness_total_min",
  };

  async function fetchDailyAggregatesFromHealthKit(Health, startIso, endIso, errors, grantedSet) {
    if (typeof Health.queryAggregated !== "function") {
      log(
        "queryAggregated indisponible — totaux jour = somme des samples (peut différer de Santé avec Apple Watch)",
      );
      return [];
    }

    const byDay = new Map();
    const specs = STATISTICS_DAILY_SPECS.filter(
      (spec) => !grantedSet || grantedSet.has(spec.type),
    );

    await Promise.all(
      specs.map(async (spec) => {
        try {
          const result = await Health.queryAggregated({
            dataType: spec.type,
            startDate: startIso,
            endDate: endIso,
            bucket: "day",
            aggregation: spec.aggregation,
          });
          const buckets = Array.isArray(result?.samples) ? result.samples : [];
          log(`  Agrégat HealthKit ${spec.type}: ${buckets.length} jour(s)`);

          for (const b of buckets) {
            const day = aggregatedBucketDayKey(b);
            const n = toNum(b.value);
            if (!day || n == null) continue;
            if (!byDay.has(day)) {
              byDay.set(day, { day, primary_source: "healthkit" });
            }
            const row = byDay.get(day);
            applyStatisticsRow(row, spec, n);
          }
        } catch (err) {
          const key = `aggregate_${spec.type}`;
          errors[key] = String(err?.message ?? err).slice(0, 500);
          log(`queryAggregated(${spec.type}) erreur: ${err}`);
        }
      }),
    );

    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  function stageToInterval(stage) {
    const start = stage?.startDate ?? stage?.start_date;
    let end = stage?.endDate ?? stage?.end_date;
    if (!start) return null;
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs)) return null;
    let mins = Number(stage?.durationMinutes);
    if (Number.isFinite(mins) && mins > 0) {
      return { startMs, endMs: startMs + mins * 60000 };
    }
    if (end) {
      let endMs = new Date(end).getTime();
      if (Number.isFinite(endMs) && endMs > startMs) return { startMs, endMs };
    }
    return null;
  }

  function sleepSampleInterval(sample) {
    const start = sample?.startDate ?? sample?.start_date;
    let end = sample?.endDate ?? sample?.end_date ?? start;
    if (!start) return null;
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs)) return null;
    let endMs = end ? new Date(end).getTime() : startMs;
    if (!Number.isFinite(endMs)) return null;
    if (endMs <= startMs) {
      const mins = toNum(sample?.value);
      if (mins != null && mins > 0) endMs = startMs + mins * 60000;
    }
    if (endMs <= startMs) return null;
    return { startMs, endMs };
  }

  function mergedIntervalMs(intervals) {
    if (!intervals.length) return 0;
    const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const iv of sorted) {
      const last = merged[merged.length - 1];
      if (!last || iv.startMs > last.endMs) {
        merged.push({ startMs: iv.startMs, endMs: iv.endMs });
      } else {
        last.endMs = Math.max(last.endMs, iv.endMs);
      }
    }
    let totalMs = 0;
    for (const iv of merged) totalMs += iv.endMs - iv.startMs;
    return totalMs;
  }

  /** Fusionne les plages qui se chevauchent (évite double comptage Watch). */
  function mergedAsleepMinutes(samples) {
    const intervals = [];
    for (const s of samples) {
      const iv = sleepSampleInterval(s);
      if (iv) intervals.push(iv);
      if (Array.isArray(s?.stages)) {
        for (const st of s.stages) {
          if (!isAsleepStageName(st?.stage ?? st?.name)) continue;
          const stIv = stageToInterval(st);
          if (stIv) intervals.push(stIv);
        }
      }
    }
    return mergedIntervalMs(intervals) / 60000;
  }

  /** Repli : regroupe les samples d'une même nuit (écart < 4 h) et prend min(start)→max(end). */
  function buildSleepDailyFromSessions(rawList) {
    if (!rawList.length) return [];
    const sorted = [...rawList].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );
    const sessions = [];
    let batch = [];
    for (const raw of sorted) {
      const t = new Date(raw.startDate).getTime();
      const prevEnd = batch.length
        ? new Date(batch[batch.length - 1].endDate ?? batch[batch.length - 1].startDate).getTime()
        : 0;
      if (batch.length && t - prevEnd > SLEEP_SESSION_GAP_MS) {
        sessions.push(batch);
        batch = [];
      }
      batch.push(raw);
    }
    if (batch.length) sessions.push(batch);

    const out = [];
    for (const session of sessions) {
      let minStart = Infinity;
      let maxEnd = -Infinity;
      let hasSleep = false;
      for (const raw of session) {
        const state = String(raw?.sleepState ?? raw?.sleep_state ?? "").toLowerCase();
        if (state.includes("awake")) continue;
        if (state.includes("inbed") || state.includes("in_bed")) continue;
        const ivs = extractSleepIntervalsFromRaw(raw);
        if (ivs.length) {
          for (const iv of ivs) {
            minStart = Math.min(minStart, iv.startMs);
            maxEnd = Math.max(maxEnd, iv.endMs);
            hasSleep = true;
          }
          continue;
        }
        const startMs = new Date(raw.startDate).getTime();
        let endMs = new Date(raw.endDate ?? raw.startDate).getTime();
        const mins = toNum(raw?.value);
        if (endMs <= startMs && mins != null && mins > 0) endMs = startMs + mins * 60000;
        if (endMs > startMs) {
          minStart = Math.min(minStart, startMs);
          maxEnd = Math.max(maxEnd, endMs);
          hasSleep = true;
        }
      }
      if (!hasSleep || maxEnd <= minStart) continue;
      const day = localDayKey(new Date(maxEnd).toISOString());
      const total = Math.round((maxEnd - minStart) / 60000);
      if (day && total > 0) {
        out.push({ day, sleep_total_min: total, primary_source: "healthkit" });
      }
    }
    return out;
  }

  function buildSleepDailyAggregatesFromRaw(rawList) {
    const nights = clusterSleepRawIntoNights(rawList);
    const byDay = new Map();

    for (const nightSamples of nights) {
      const bySrc = new Map();
      for (const raw of nightSamples) {
        const src = String(raw?.sourceName ?? raw?.sourceId ?? "unknown");
        if (!bySrc.has(src)) bySrc.set(src, []);
        bySrc.get(src).push(raw);
      }

      let bestTotalMs = 0;
      let bestPri = -1;
      let wakeMs = 0;

      for (const [src, list] of bySrc) {
        const intervals = [];
        for (const raw of list) intervals.push(...extractSleepIntervalsFromRaw(raw));
        const totalMs = mergedIntervalMs(intervals);
        const pri = sleepSourcePriority(src);
        const maxEnd =
          intervals.length > 0 ? Math.max(...intervals.map((i) => i.endMs)) : 0;
        if (totalMs > 0 && (pri > bestPri || (pri === bestPri && totalMs > bestTotalMs))) {
          bestPri = pri;
          bestTotalMs = totalMs;
          wakeMs = maxEnd;
        }
      }

      if (bestTotalMs <= 0 || !wakeMs) continue;
      const day = localDayKey(new Date(wakeMs).toISOString());
      const mins = Math.round(bestTotalMs / 60000);
      if (!day || mins <= 0) continue;
      byDay.set(day, (byDay.get(day) || 0) + mins);
    }

    const out = [...byDay.entries()]
      .map(([day, sleep_total_min]) => ({ day, sleep_total_min, primary_source: "healthkit" }))
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));

    if (out.length > 0) return out;
    return buildSleepDailyFromSessions(rawList);
  }

  function buildSleepDailyAggregates(sleepSamples) {
    return buildSleepDailyAggregatesFromRaw(sleepSamples);
  }

  function applyStatisticsRow(row, spec, n) {
    if (spec.intField) {
      row[spec.field] = Math.round(n);
    } else if (spec.field === "distance_total_m") {
      row.distance_total_m = Math.round(n * 100) / 100;
    } else if (spec.field === "calories_total_kcal") {
      row.calories_total_kcal = Math.round(n * 100) / 100;
    } else if (spec.extraOnly) {
      row.extra = row.extra && typeof row.extra === "object" ? row.extra : {};
      row.extra[spec.field] = spec.intField ? Math.round(n) : Math.round(n * 100) / 100;
    } else {
      row[spec.field] = Math.round(n * 100) / 100;
    }
  }

  function buildClientDailyRollups(samplesByType) {
    const byDay = new Map();

    function bucket(day) {
      if (!byDay.has(day)) {
        byDay.set(day, { day, primary_source: "healthkit", sums: {}, avgs: {}, extra: {} });
      }
      return byDay.get(day);
    }

    for (const [type, field] of Object.entries(SUM_DAILY_FIELDS)) {
      const samples = samplesByType[type]?.samples ?? [];
      for (const s of samples) {
        const day = localDayKey(s.startDate);
        if (!day || s.value == null) continue;
        const b = bucket(day);
        b.sums[field] = (b.sums[field] || 0) + s.value;
      }
    }

    for (const [type, field] of Object.entries(VITAL_AVG_FIELDS)) {
      const samples = samplesByType[type]?.samples ?? [];
      for (const s of samples) {
        const day = localDayKey(s.startDate);
        if (!day || s.value == null) continue;
        const b = bucket(day);
        if (!b.avgs[field]) b.avgs[field] = { sum: 0, count: 0 };
        b.avgs[field].sum += s.value;
        b.avgs[field].count += 1;
      }
    }

    const out = [];
    for (const [, b] of byDay) {
      const row = { day: b.day, primary_source: "healthkit" };
      let has = false;
      for (const [field, total] of Object.entries(b.sums)) {
        if (total > 0) {
          if (field === "exercise_time_min") {
            row.extra = row.extra && typeof row.extra === "object" ? row.extra : {};
            row.extra.exercise_time_min = Math.round(total);
          } else {
            row[field] = Math.round(total);
          }
          has = true;
        }
      }
      for (const [field, { sum, count }] of Object.entries(b.avgs)) {
        if (count > 0) {
          row[field] = Math.round((sum / count) * 100) / 100;
          has = true;
        }
      }
      const extraOut = {};
      for (const [field, val] of Object.entries(b.extra)) {
        if (val != null) {
          extraOut[field] = val;
          has = true;
        }
      }
      if (Object.keys(extraOut).length > 0) {
        row.extra = extraOut;
      }
      if (has) out.push(row);
    }
    return out.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  /**
   * Repli pas : queryAggregated peut omettre steps_total alors que calories est présent.
   * Sans sample steps en base, un lot vitaux/sommeil seul efface steps_total côté serveur.
   */
  async function fillStepsGapsInDailyAggregates(Health, dailyList, startIso, endIso, grantedSet) {
    if (!grantedSet?.has("steps")) return dailyList ?? [];
    const list = Array.isArray(dailyList) ? dailyList.map((row) => ({ ...row })) : [];
    const needsFill = list.some(
      (row) => row?.day && (row.steps_total == null || row.steps_total <= 0),
    );
    if (!needsFill) return list;

    let samples;
    try {
      samples = await readAllSamples(Health, "steps", startIso, endIso);
    } catch (err) {
      log(`fillStepsGaps readSamples(steps) erreur: ${err}`);
      return list;
    }
    if (!samples.length) return list;

    const stepsByDay = new Map();
    for (const s of samples) {
      const day = localDayKey(s.startDate);
      const n = toNum(s.value);
      if (!day || n == null || n <= 0) continue;
      stepsByDay.set(day, (stepsByDay.get(day) || 0) + n);
    }
    if (stepsByDay.size === 0) return list;

    const byDay = new Map(list.map((row) => [row.day, row]));
    let filled = 0;
    for (const [day, total] of stepsByDay) {
      const row = byDay.get(day) ?? { day, primary_source: "healthkit" };
      if (row.steps_total == null || row.steps_total <= 0) {
        row.steps_total = Math.round(total);
        byDay.set(day, row);
        filled += 1;
      }
    }
    if (filled > 0) {
      log(`  Pas (repli readSamples) : ${filled} jour(s) complété(s) — évite steps_total=null au rollup`);
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  function mergeDailyAggregateRows(baseList, extraList) {
    const byDay = new Map(baseList.map((row) => [row.day, { ...row }]));
    for (const row of extraList) {
      const existing = byDay.get(row.day);
      if (!existing) {
        byDay.set(row.day, { ...row });
        continue;
      }
      for (const key of Object.keys(row)) {
        if (key === "day" || key === "primary_source") continue;
        if (key === "extra" && row.extra && typeof row.extra === "object") {
          existing.extra = { ...(existing.extra || {}), ...row.extra };
        } else if (row[key] != null && existing[key] == null) {
          existing[key] = row[key];
        }
      }
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  function mergeSleepDailyRows(dailyList, sleepRows) {
    if (!Array.isArray(sleepRows) || sleepRows.length === 0) return dailyList;
    const byDay = new Map(dailyList.map((row) => [row.day, { ...row }]));
    for (const row of sleepRows) {
      if (!row?.day || !(row.sleep_total_min > 0)) continue;
      const existing = byDay.get(row.day);
      if (existing) {
        // Sommeil = readSamples uniquement (Capgo ne statistique pas ce type) → valeur autoritaire.
        existing.sleep_total_min = row.sleep_total_min;
      } else {
        byDay.set(row.day, { ...row });
      }
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  function mergeSleepIntoDailyAggregates(dailyList, sleepSamples) {
    if (!Array.isArray(sleepSamples) || sleepSamples.length === 0) return dailyList;
    const byDay = new Map(dailyList.map((row) => [row.day, { ...row }]));
    for (const row of buildSleepDailyAggregates(sleepSamples)) {
      const existing = byDay.get(row.day);
      if (existing) {
        if (row.sleep_total_min > 0) existing.sleep_total_min = row.sleep_total_min;
      } else if (row.sleep_total_min > 0) {
        byDay.set(row.day, row);
      }
    }
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }

  /** Log des totaux journaliers envoyés — comparaison directe avec l'app Santé. */
  function logDailyParitySummary(dailyAggregates) {
    if (!Array.isArray(dailyAggregates) || dailyAggregates.length === 0) return;
    const recent = dailyAggregates.slice(-3);
    log("──── Totaux journaliers (doivent = Santé iOS) ────");
    for (const row of recent) {
      const extra = row.extra && typeof row.extra === "object" ? row.extra : {};
      log(
        `  ${row.day}: pas=${row.steps_total ?? "—"} dist=${row.distance_total_m ?? "—"}m cal=${row.calories_total_kcal ?? "—"} sommeil=${row.sleep_total_min ?? "—"}min hrv=${row.hrv_avg_ms ?? "—"} fc_repos=${row.resting_heart_rate_avg ?? "—"} resp=${row.respiratory_rate_avg ?? "—"} spo2=${row.oxygen_saturation_avg ?? "—"} temp=${row.body_temperature_avg ?? "—"} ex=${extra.exercise_time_min ?? "—"}`,
      );
    }
  }

  function samplePageSize(dataType) {
    return HIGH_VOLUME_SAMPLE_TYPES.has(dataType) ? SAMPLE_PAGE_SIZE_HIGH : SAMPLE_PAGE_SIZE;
  }

  function sampleStartMs(raw) {
    const iso = raw?.startDate ?? raw?.start_date;
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function oldestStartMsInBatch(batch) {
    let oldest = Infinity;
    for (const raw of batch) {
      const t = sampleStartMs(raw);
      if (t != null && t < oldest) oldest = t;
    }
    return Number.isFinite(oldest) ? oldest : null;
  }

  /**
   * Lit une fenêtre [startIso, endIso] avec pagination anchor.
   * Repli : page pleine sans anchor → recule endDate (Capgo 8.6 tronque souvent à 1000).
   */
  async function readAllSamplesPaged(Health, dataType, startIso, endIso) {
    const limit = samplePageSize(dataType);
    const byPlatformId = new Map();
    let windowEndIso = endIso;
    const startMs = new Date(startIso).getTime();
    let rawTotal = 0;
    let totalPages = 0;
    let truncated = false;
    let windowPasses = 0;

    while (new Date(windowEndIso).getTime() > startMs && windowPasses < 400) {
      windowPasses += 1;
      let anchor;
      let pagesInPass = 0;
      let lastBatch = [];

      while (pagesInPass < MAX_SAMPLE_PAGES) {
        const req = {
          dataType,
          startDate: startIso,
          endDate: windowEndIso,
          limit,
          ascending: false,
        };
        if (anchor) req.anchor = anchor;

        const result = await Health.readSamples(req);
        const batch = result?.samples ?? [];
        lastBatch = batch;
        rawTotal += batch.length;
        pagesInPass += 1;
        totalPages += 1;

        for (const raw of batch) {
          const norm = normalizeSample(dataType, raw);
          if (norm) byPlatformId.set(norm.platformId, norm);
        }

        const next = result?.anchor;
        if (next && batch.length > 0) {
          anchor = next;
          if (READ_STAGGER_MS > 0) {
            await new Promise((resolve) => setTimeout(resolve, READ_STAGGER_MS));
          }
          continue;
        }
        break;
      }

      if (pagesInPass >= MAX_SAMPLE_PAGES) truncated = true;

      if (lastBatch.length >= limit) {
        const oldestMs = oldestStartMsInBatch(lastBatch);
        if (oldestMs != null && oldestMs > startMs) {
          windowEndIso = new Date(oldestMs - 1).toISOString();
          if (READ_STAGGER_MS > 0) {
            await new Promise((resolve) => setTimeout(resolve, READ_STAGGER_MS));
          }
          continue;
        }
        truncated = true;
      }
      break;
    }

    return {
      samples: [...byPlatformId.values()],
      rawTotal,
      totalPages,
      truncated,
    };
  }

  /** Tranches de DATE_CHUNK_DAYS j lues en parallèle pour couvrir les 60j malgré le plafond Capgo. */
  function buildDateChunkRanges(startIso, endIso) {
    const chunkMs = DATE_CHUNK_DAYS * 24 * 60 * 60 * 1000;
    const startMs = new Date(startIso).getTime();
    let endMs = new Date(endIso).getTime();
    const ranges = [];
    while (endMs > startMs) {
      const chunkStartMs = Math.max(startMs, endMs - chunkMs);
      ranges.push({
        startIso: new Date(chunkStartMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
      });
      endMs = chunkStartMs - 1;
    }
    return ranges;
  }

  async function readAllSamplesByDateChunks(Health, dataType, startIso, endIso) {
    const ranges = buildDateChunkRanges(startIso, endIso);
    const byPlatformId = new Map();
    let rawTotal = 0;
    let truncated = false;

    const pages = await runWithConcurrency(ranges, CHUNK_READ_CONCURRENCY, async (range) =>
      readAllSamplesPaged(Health, dataType, range.startIso, range.endIso),
    );

    for (const page of pages) {
      rawTotal += page.rawTotal;
      truncated = truncated || page.truncated;
      for (const s of page.samples) byPlatformId.set(s.platformId, s);
    }

    const samples = [...byPlatformId.values()];
    log(
      `  ${dataType}: ${samples.length} samples (${ranges.length}×${DATE_CHUNK_DAYS}j∥, ${rawTotal} bruts${truncated ? ", tronqué" : ""})`,
    );
    return { samples, truncated };
  }

  /**
   * Types denses : lit une tranche calendaire → POST immédiat → tranche suivante.
   * Les tranches vont du plus récent au plus ancien (données fraîches en premier).
   */
  async function readAndStreamSamplesByDateChunks(Health, dataType, startIso, endIso, onChunkReady) {
    const ranges = buildDateChunkRanges(startIso, endIso);
    const byPlatformId = new Map();
    let rawTotal = 0;
    let truncated = false;

    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const page = await readAllSamplesPaged(Health, dataType, range.startIso, range.endIso);
      rawTotal += page.rawTotal;
      truncated = truncated || page.truncated;

      const chunkSamples = [];
      for (const s of page.samples) {
        if (!byPlatformId.has(s.platformId)) {
          byPlatformId.set(s.platformId, s);
          chunkSamples.push(s);
        }
      }

      if (chunkSamples.length > 0 && onChunkReady) {
        const block = {
          data_type: dataType,
          unit_default: defaultUnit(dataType),
          sample_count: chunkSamples.length,
          samples: chunkSamples,
        };
        const postRes = await onChunkReady(block, i + 1, ranges.length);
        if (postRes && !postRes.ok) {
          return {
            ok: false,
            postRes,
            samples: [...byPlatformId.values()],
            rawTotal,
            truncated,
          };
        }
      }
    }

    const samples = [...byPlatformId.values()];
    log(
      `  ${dataType}: ${samples.length} samples (${ranges.length}×${DATE_CHUNK_DAYS}j stream→POST, ${rawTotal} bruts${truncated ? ", tronqué" : ""})`,
    );
    return { ok: true, samples, rawTotal, truncated };
  }

  function accumulateSampleBlock(samplesByType, typeKey, block) {
    const prev = samplesByType[typeKey];
    if (!prev) {
      samplesByType[typeKey] = {
        ...block,
        samples: [...block.samples],
      };
      return;
    }
    prev.samples.push(...block.samples);
    prev.sample_count = prev.samples.length;
  }

  /** Lit toutes les pages HealthKit (anchor + tranches calendaires si besoin). */
  async function readAllSamples(Health, dataType, startIso, endIso) {
    const meta = await readAllSamplesWithMeta(Health, dataType, startIso, endIso);
    return meta.samples;
  }

  async function readAllSamplesWithMeta(Health, dataType, startIso, endIso) {
    if (DATE_CHUNK_READ_TYPES.has(dataType)) {
      return readAllSamplesByDateChunks(Health, dataType, startIso, endIso);
    }

    const page = await readAllSamplesPaged(Health, dataType, startIso, endIso);
    if (page.truncated) {
      log(
        `  ${dataType}: ATTENTION pagination tronquée (${page.totalPages} pages) — total peut différer de Santé`,
      );
    }
    if (page.totalPages > 1 || (page.rawTotal > 0 && page.samples.length !== page.rawTotal)) {
      log(
        `  ${dataType}: ${page.samples.length} samples (${page.totalPages} pages, ${page.rawTotal} bruts)`,
      );
    }
    return { samples: page.samples, truncated: !!page.truncated };
  }

  /** Sommeil : tranches calendaires en parallèle (1 passe par tranche, plus de double scan). */
  async function readAllSleepSamples(Health, startIso, endIso, options = {}) {
    const light = options.light === true;
    const limit = samplePageSize("sleep");
    const rawById = new Map();
    let rawTotal = 0;
    let pages = 0;
    let truncated = false;

    async function readSleepChunk(chunkStartIso, chunkEndIso) {
      let anchor;
      let passPages = 0;
      let chunkRaw = 0;
      let chunkTruncated = false;
      while (passPages < MAX_SLEEP_SAMPLE_PAGES) {
        const req = {
          dataType: "sleep",
          startDate: chunkStartIso,
          endDate: chunkEndIso,
          limit,
          ascending: false,
        };
        if (anchor) req.anchor = anchor;

        const result = await Health.readSamples(req);
        const batch = result?.samples ?? [];
        chunkRaw += batch.length;
        passPages += 1;
        for (const raw of batch) {
          const pid = raw?.platformId ?? raw?.id;
          const key =
            pid != null ? String(pid) : `sleep|${raw?.startDate}|${raw?.endDate}|${raw?.sleepState}`;
          rawById.set(key, raw);
        }

        const next = result?.anchor;
        if (!next || batch.length === 0) break;
        anchor = next;
        if (passPages >= MAX_SLEEP_SAMPLE_PAGES) {
          chunkTruncated = true;
          break;
        }
      }
      return { chunkRaw, passPages, chunkTruncated };
    }

    const ranges = buildDateChunkRanges(startIso, endIso);
    const chunkStats = await runWithConcurrency(ranges, CHUNK_READ_CONCURRENCY, (range) =>
      readSleepChunk(range.startIso, range.endIso),
    );
    for (const st of chunkStats) {
      rawTotal += st.chunkRaw;
      pages += st.passPages;
      truncated = truncated || st.chunkTruncated;
    }

    const raw = [...rawById.values()];
    const dailyRows = buildSleepDailyAggregatesFromRaw(raw);
    if (light) {
      log(
        `  sleep (léger): ${raw.length} bruts (${ranges.length}×${DATE_CHUNK_DAYS}j∥, ${pages} pages) → ${dailyRows.length} nuit(s), stades compacts à l'envoi`,
      );
      if (truncated) {
        log(
          "  sleep (léger): ATTENTION pagination tronquée — total sommeil peut être sous-estimé vs Santé",
        );
      }
      return { raw, normalized: [], dailyRows, truncated };
    }

    const normalized = [];
    for (const r of raw) {
      normalized.push(...normalizeSleepSamples(r));
    }
    const staged = normalized.filter((s) => s.stage).length;
    log(
      `  sleep: ${raw.length} bruts (${ranges.length}×${DATE_CHUNK_DAYS}j∥, ${pages} pages) → ${normalized.length} segment(s)${staged ? ` (${staged} avec stage)` : ""}, ${dailyRows.length} nuit(s)`,
    );
    if (normalized.length > 0) {
      logSleepSegmentSummary(normalized, "  sleep stades (lecture HK)", dailyRows);
    } else if (raw.length > 0) {
      log("  sleep stades (lecture HK): 0 segment normalisé — Capgo sans stages[] ?");
    }
    if (truncated) {
      log(
        "  sleep: ATTENTION pagination tronquée — total sommeil peut être sous-estimé vs Santé",
      );
    }
    if (raw.length > 0 && dailyRows.length === 0) {
      const preview = raw.slice(0, 3).map(sleepRawDebugLine).join(" | ");
      log(`Sommeil: ${raw.length} segment(s) non converti(s) — ${preview}`);
      log(
        "  Vérifiez Santé → Sommeil (durée endormi, pas seulement au lit) et que la montre a enregistré la nuit",
      );
    }
    return { raw, normalized, dailyRows, truncated };
  }

  /** Température poignet Apple Watch — natif iOS (Capgo ne l'expose pas). */
  function readNativeWristTemperatureSamples(startIso, endIso) {
    return new Promise((resolve) => {
      const handler = window.webkit?.messageHandlers?.pcpHealthReadWristTemperature;
      if (!handler) {
        resolve({ samples: [], diagnostics: { count: 0, authLabel: "bridge_missing" } });
        return;
      }
      const requestId = crypto.randomUUID();
      window.__pcpWristTempCallbacks = window.__pcpWristTempCallbacks || {};
      const timer = window.setTimeout(() => {
        delete window.__pcpWristTempCallbacks[requestId];
        resolve({ samples: [], diagnostics: { count: 0, authLabel: "timeout_15s" } });
      }, 15000);
      window.__pcpWristTempCallbacks[requestId] = (payload) => {
        window.clearTimeout(timer);
        if (Array.isArray(payload)) {
          resolve({ samples: payload, diagnostics: { count: payload.length, authLabel: "legacy_array" } });
          return;
        }
        const samples = Array.isArray(payload?.samples) ? payload.samples : [];
        const diagnostics =
          payload?.diagnostics && typeof payload.diagnostics === "object"
            ? payload.diagnostics
            : { count: samples.length };
        resolve({ samples, diagnostics });
      };
      try {
        handler.postMessage({ startDate: startIso, endDate: endIso, requestId });
      } catch (_) {
        window.clearTimeout(timer);
        delete window.__pcpWristTempCallbacks[requestId];
        resolve({ samples: [], diagnostics: { count: 0, authLabel: "postMessage_failed" } });
      }
    });
  }

  /** VO₂ max — pont natif HealthKit (repli si Capgo échoue ou renvoie 0). */
  function readNativeVo2MaxSamples(startIso, endIso) {
    return new Promise((resolve) => {
      const handler = window.webkit?.messageHandlers?.pcpHealthReadVo2Max;
      if (!handler) {
        resolve({ samples: [], diagnostics: { count: 0, authLabel: "bridge_missing" } });
        return;
      }
      const requestId = crypto.randomUUID();
      window.__pcpVo2MaxCallbacks = window.__pcpVo2MaxCallbacks || {};
      const timer = window.setTimeout(() => {
        delete window.__pcpVo2MaxCallbacks[requestId];
        resolve({ samples: [], diagnostics: { count: 0, authLabel: "timeout_15s" } });
      }, 15000);
      window.__pcpVo2MaxCallbacks[requestId] = (payload) => {
        window.clearTimeout(timer);
        if (Array.isArray(payload)) {
          resolve({ samples: payload, diagnostics: { count: payload.length, authLabel: "legacy_array" } });
          return;
        }
        const samples = Array.isArray(payload?.samples) ? payload.samples : [];
        const diagnostics =
          payload?.diagnostics && typeof payload.diagnostics === "object"
            ? payload.diagnostics
            : { count: samples.length };
        resolve({ samples, diagnostics });
      };
      try {
        handler.postMessage({ startDate: startIso, endDate: endIso, requestId });
      } catch (_) {
        window.clearTimeout(timer);
        delete window.__pcpVo2MaxCallbacks[requestId];
        resolve({ samples: [], diagnostics: { count: 0, authLabel: "postMessage_failed" } });
      }
    });
  }

  function logVo2NativeDiagnostics(diagnostics, nativeCount, sourceLabel) {
    const d = diagnostics || {};
    const count = typeof d.count === "number" ? d.count : nativeCount;
    const hkType = d.hkType ?? "HKQuantityTypeIdentifierVO2Max";
    const auth = d.authLabel ?? d.authStatus ?? "?";
    const latest = d.latestStartDate ?? "—";
    let line = `  VO₂ max ${sourceLabel}: ${count} sample(s) | auth=${auth} | hkType=${hkType}`;
    const srcSummary = formatDiagnosticsSources(d.sources);
    if (srcSummary) line += ` | sources={${srcSummary}}`;
    if (count > 0 && latest !== "—") line += ` | dernière @ ${latest}`;
    if (d.error) line += ` | erreur=${String(d.error).slice(0, 120)}`;
    if (auth === "bridge_missing") line += " | pont absent — rebuild Xcode requis";
    if (auth === "write_denied" || auth === "denied") {
      line += " | (statut écriture — lecture HK non vérifiable par l'app)";
    }
    log(line);
  }

  /** Workouts — pont natif HealthKit (repli si Capgo queryWorkouts renvoie 0). */
  function readNativeWorkoutSamples(startIso, endIso) {
    return new Promise((resolve) => {
      const handler = window.webkit?.messageHandlers?.pcpHealthReadWorkouts;
      if (!handler) {
        resolve({ workouts: [], diagnostics: { count: 0, authLabel: "bridge_missing" } });
        return;
      }
      const requestId = crypto.randomUUID();
      window.__pcpWorkoutsCallbacks = window.__pcpWorkoutsCallbacks || {};
      const timer = window.setTimeout(() => {
        delete window.__pcpWorkoutsCallbacks[requestId];
        resolve({ workouts: [], diagnostics: { count: 0, authLabel: "timeout_30s" } });
      }, 30000);
      window.__pcpWorkoutsCallbacks[requestId] = (payload) => {
        window.clearTimeout(timer);
        if (Array.isArray(payload)) {
          resolve({ workouts: payload, diagnostics: { count: payload.length, authLabel: "legacy_array" } });
          return;
        }
        const workouts = Array.isArray(payload?.workouts) ? payload.workouts : [];
        const diagnostics =
          payload?.diagnostics && typeof payload.diagnostics === "object"
            ? payload.diagnostics
            : { count: workouts.length };
        resolve({ workouts, diagnostics });
      };
      try {
        handler.postMessage({ startDate: startIso, endDate: endIso, requestId });
      } catch (_) {
        window.clearTimeout(timer);
        delete window.__pcpWorkoutsCallbacks[requestId];
        resolve({ workouts: [], diagnostics: { count: 0, authLabel: "postMessage_failed" } });
      }
    });
  }

  function logWorkoutsNativeDiagnostics(diagnostics, nativeCount, sourceLabel) {
    const d = diagnostics || {};
    const count = typeof d.count === "number" ? d.count : nativeCount;
    const auth = d.authLabel ?? d.authStatus ?? "?";
    let line = `  workouts ${sourceLabel}: ${count} séance(s) | auth=${auth}`;
    if (d.types && typeof d.types === "object") {
      const parts = Object.entries(d.types)
        .slice(0, 6)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      if (parts) line += ` | types={${parts}}`;
    }
    if (d.error) line += ` | erreur=${String(d.error).slice(0, 120)}`;
    if (auth === "bridge_missing") line += " | pont absent — rebuild Xcode requis";
    if (auth === "write_denied" || auth === "denied") {
      line += " | (statut écriture — lecture HK non vérifiable par l'app)";
    }
    log(line);
  }
  /**
   * VO₂ max : HealthKit natif uniquement (Capgo iOS : type non supporté).
   */
  async function fetchAllVo2MaxSamples(_Health, startIso, endIso, readGranted, readDenied, errors) {
    const byPlatformId = new Map();

    if (READ_STAGGER_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, READ_STAGGER_MS));
    }

    const nativeResult = await readNativeVo2MaxSamples(startIso, endIso);
    const nativeRaw = nativeResult?.samples ?? [];
    const diag = nativeResult?.diagnostics ?? {};
    logVo2NativeDiagnostics(diag, nativeRaw.length, "(natif)");

    for (const raw of nativeRaw) {
      const tagged = { ...raw, dataType: "vo2Max" };
      const norm = normalizeSample("vo2Max", tagged);
      if (!norm?.platformId) continue;
      norm.origin = raw.origin ?? "HKQuantityTypeIdentifierVO2Max";
      byPlatformId.set(norm.platformId, norm);
    }

    if (byPlatformId.size > 0) {
      if (!readGranted.includes("vo2Max")) readGranted.push("vo2Max");
      log(`  VO₂ max natif: ${byPlatformId.size} sample(s) envoyé(s)`);
    } else if (diag.authLabel === "bridge_missing") {
      log("  VO₂ max: aucune source — rebuild iOS + autoriser VO₂ max dans Santé");
    } else if (diag?.authStatus === "denied") {
      if (!readDenied.includes("vo2Max")) readDenied.push("vo2Max");
    } else if (nativeResult?.error) {
      errors.vo2Max = String(nativeResult.error).slice(0, 500);
    }

    return [...byPlatformId.values()];
  }

  function formatTempLogValue(raw) {
    const v = raw?.value;
    if (v == null || !Number.isFinite(Number(v))) return "—";
    return `${Number(v).toFixed(2)} °C`;
  }

  /** Résumé par type HealthKit + source (logs testeur). */
  function logTemperatureByTypeAndSource(hkType, rawSamples) {
    const n = Array.isArray(rawSamples) ? rawSamples.length : 0;
    if (n === 0) {
      log(`  Temp type=${hkType}: 0 sample(s)`);
      return;
    }
    /** @type {Map<string, { hkType: string, source: string, count: number, latestStart: string, latestValue: string }>} */
    const groups = new Map();
    for (const raw of rawSamples) {
      const type = raw?.origin ?? hkType;
      const source = String(raw?.sourceName ?? raw?.sourceId ?? "?");
      const key = `${type}|${source}`;
      const start = raw?.startDate ?? raw?.start_date ?? "";
      const prev = groups.get(key);
      if (!prev) {
        groups.set(key, {
          hkType: type,
          source,
          count: 1,
          latestStart: start,
          latestValue: formatTempLogValue(raw),
        });
        continue;
      }
      prev.count += 1;
      if (start && (!prev.latestStart || start > prev.latestStart)) {
        prev.latestStart = start;
        prev.latestValue = formatTempLogValue(raw);
      }
    }
    log(`  Temp type=${hkType}: ${n} sample(s) brut(s)`);
    for (const g of groups.values()) {
      log(
        `      · hkType=${g.hkType} source=${g.source} n=${g.count} dernière=${g.latestStart || "—"} val=${g.latestValue}`,
      );
    }
  }

  function formatDiagnosticsSources(sources) {
    if (!sources || typeof sources !== "object") return "";
    const parts = Object.entries(sources).map(([name, count]) => `${name}:${count}`);
    return parts.length ? parts.join(", ") : "";
  }

  function logWristTemperatureDiagnostics(diagnostics, capgoBodyCount, wristRaw) {
    const d = diagnostics || {};
    const count = typeof d.count === "number" ? d.count : 0;
    const hkType = d.hkType ?? "appleSleepingWristTemperature";
    const auth = d.authLabel ?? d.authStatus ?? "?";
    const latest = d.latestStartDate ?? "—";
    const window =
      d.windowStart && d.windowEnd ? `${d.windowStart} → ${d.windowEnd}` : `${LOOKBACK_DAYS} j`;
    let line = `  Temp type=${hkType} (natif): ${count} sample(s) | auth=${auth} | fenêtre ${window}`;
    const srcSummary = formatDiagnosticsSources(d.sources);
    if (srcSummary) {
      line += ` | sources={${srcSummary}}`;
    }
    if (count > 0 && latest !== "—") {
      line += ` | dernière @ ${latest}`;
    }
    if (d.error) {
      line += ` | erreur=${String(d.error).slice(0, 120)}`;
    }
    if (auth === "bridge_missing") {
      line += " | pont WebView absent — rebuild iOS requis";
    }
    if (count === 0 && capgoBodyCount > 0) {
      line += " | note: bodyTemperature Capgo OK, poignet vide côté HealthKit";
    }
    log(line);
    if (Array.isArray(wristRaw) && wristRaw.length > 0) {
      logTemperatureByTypeAndSource(hkType, wristRaw);
    }
  }

  /**
   * Température : bodyTemperature (thermomètre) + basalBodyTemperature + poignet Watch.
   * Apple Watch Series 8+ stocke la température sous appleSleepingWristTemperature (lecture native).
   */
  async function fetchAllTemperatureSamples(Health, startIso, endIso, readGranted, readDenied, errors) {
    const byPlatformId = new Map();
    let capgoBodyCount = 0;

    for (const capgoType of ["bodyTemperature", "basalBodyTemperature"]) {
      if (READ_STAGGER_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, READ_STAGGER_MS));
      }
      try {
        const auth = await Health.checkAuthorization({ read: [capgoType], write: [] });
        const ok = Array.isArray(auth?.readAuthorized) && auth.readAuthorized.includes(capgoType);
        if (!ok) {
          if (!readDenied.includes(capgoType)) readDenied.push(capgoType);
          log(`  Temp type=${capgoType}: 0 sample(s) | auth=refusée`);
          continue;
        }
        if (!readGranted.includes(capgoType)) readGranted.push(capgoType);
        const rawSamples = await readAllSamples(Health, capgoType, startIso, endIso);
        logTemperatureByTypeAndSource(capgoType, rawSamples);
        for (const raw of rawSamples) {
          const tagged = { ...raw, origin: capgoType };
          const norm = normalizeSample("bodyTemperature", tagged);
          if (norm) {
            if (capgoType !== "bodyTemperature") {
              norm.hkType = capgoType;
              norm.origin = capgoType;
            }
            byPlatformId.set(norm.platformId, norm);
          }
        }
        if (rawSamples.length > 0 && capgoType === "bodyTemperature") {
          capgoBodyCount += rawSamples.length;
        }
      } catch (err) {
        errors[capgoType] = String(err?.message ?? err).slice(0, 500);
        log(`readSamples(${capgoType}) erreur: ${err}`);
      }
    }

    try {
      const wristResult = await readNativeWristTemperatureSamples(startIso, endIso);
      const wristRaw = wristResult?.samples ?? [];
      logWristTemperatureDiagnostics(wristResult?.diagnostics, capgoBodyCount, wristRaw);
      for (const raw of wristRaw) {
        const tagged = {
          ...raw,
          origin: raw.origin ?? "appleSleepingWristTemperature",
        };
        const norm = normalizeSample("bodyTemperature", tagged);
        if (norm) {
          norm.hkType = "appleSleepingWristTemperature";
          norm.origin = "appleSleepingWristTemperature";
          byPlatformId.set(norm.platformId, norm);
        }
      }
    } catch (err) {
      errors.wristTemperature = String(err?.message ?? err).slice(0, 500);
      log(`température poignet (natif) erreur: ${err}`);
    }

    const samples = [...byPlatformId.values()];
    if (samples.length > 0) {
      log(`  Température fusionnée → backend dataType=bodyTemperature (${samples.length} sample(s)):`);
      /** @type {Map<string, { hkType: string, source: string, count: number, latestStart: string, latestValue: string }>} */
      const merged = new Map();
      for (const s of samples) {
        const type = s.origin ?? s.hkType ?? "bodyTemperature";
        const source = String(s.sourceName ?? s.sourceId ?? "?");
        const key = `${type}|${source}`;
        const start = s.startDate ?? "";
        const prev = merged.get(key);
        const val = `${Number(s.value).toFixed(2)} °C`;
        if (!prev) {
          merged.set(key, {
            hkType: type,
            source,
            count: 1,
            latestStart: start,
            latestValue: val,
          });
          continue;
        }
        prev.count += 1;
        if (start && (!prev.latestStart || start > prev.latestStart)) {
          prev.latestStart = start;
          prev.latestValue = val;
        }
      }
      for (const g of merged.values()) {
        log(
          `      · hkType=${g.hkType} source=${g.source} n=${g.count} dernière=${g.latestStart || "—"} val=${g.latestValue}`,
        );
      }
    } else {
      log(
        "  Température: aucune donnée — Apple Watch = température poignet (Sommeil, ~5 nuits pour baseline) ; iPhone seul = souvent vide",
      );
    }
    return samples;
  }

  async function fetchAllWorkouts(Health, startIso, endIso) {
    const byPlatformId = new Map();
    let capgoPages = 0;
    let capgoCount = 0;

    if (typeof Health?.queryWorkouts === "function") {
      let anchor;
      while (capgoPages < MAX_WORKOUT_PAGES) {
        const req = {
          startDate: startIso,
          endDate: endIso,
          limit: WORKOUT_PAGE_SIZE,
          ascending: false,
        };
        if (anchor) req.anchor = anchor;

        const result = await Health.queryWorkouts(req);
        const batch = result?.workouts ?? [];
        capgoCount += batch.length;
        for (const raw of batch) {
          const norm = normalizeWorkout(raw);
          if (norm?.startDate && norm?.endDate) {
            byPlatformId.set(norm.platformId, norm);
          }
        }

        const next = result?.anchor;
        capgoPages += 1;
        if (!next || batch.length === 0) break;
        anchor = next;
        if (READ_STAGGER_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, READ_STAGGER_MS));
        }
      }
      log(`  workouts Capgo: ${capgoCount} bruts (${capgoPages} page(s))`);
    }

    const nativeResult = await readNativeWorkoutSamples(startIso, endIso);
    const nativeRaw = nativeResult?.workouts ?? [];
    const diag = nativeResult?.diagnostics ?? {};
    logWorkoutsNativeDiagnostics(diag, nativeRaw.length, "(natif)");
    for (const raw of nativeRaw) {
      const norm = normalizeWorkout(raw);
      if (norm?.startDate && norm?.endDate) {
        byPlatformId.set(norm.platformId, norm);
      }
    }

    const items = [...byPlatformId.values()];
    const source =
      capgoCount > 0 && nativeRaw.length > 0
        ? "Capgo+natif"
        : capgoCount > 0
          ? `Capgo ${capgoPages}p`
          : nativeRaw.length > 0
            ? "natif"
            : capgoPages > 0
              ? `Capgo ${capgoPages}p→0, natif→0`
              : "aucune";
    log(`  workouts: ${items.length} (${source})`);
    return items;
  }

  /**
   * FC uniquement pendant les séances — alimente TRIMP backend (effort + bonus sommeil)
   * sans lire la FC continue 24/7 (goulot Apple Watch sur 60j).
   */
  async function fetchHeartRateSamplesForWorkouts(Health, workouts, grantedSet, errors) {
    if (!grantedSet?.has("heartRate")) return [];
    const windows = (workouts ?? [])
      .filter((w) => w?.startDate && w?.endDate)
      .map((w) => ({ startIso: w.startDate, endIso: w.endDate }));
    if (windows.length === 0) return [];

    const byPlatformId = new Map();
    await runWithConcurrency(windows, 3, async (win) => {
      try {
        const rawList = await readAllSamples(Health, "heartRate", win.startIso, win.endIso);
        for (const raw of rawList) {
          const norm = normalizeSample("heartRate", raw);
          if (norm?.platformId) byPlatformId.set(norm.platformId, norm);
        }
      } catch (err) {
        errors.heartRate_workout = String(err?.message ?? err).slice(0, 500);
      }
    });
    log(`  FC workout: ${byPlatformId.size} sample(s) sur ${windows.length} séance(s)`);
    return [...byPlatformId.values()];
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Durée workout (secondes) — l'API attend un entier (HealthKit renvoie des float). */
  function toIntOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  function defaultUnit(type) {
    const map = {
      steps: "count",
      distance: "meter",
      calories: "kilocalorie",
      heartRate: "bpm",
      weight: "kilogram",
      sleep: "minute",
      respiratoryRate: "bpm",
      oxygenSaturation: "percent",
      restingHeartRate: "bpm",
      heartRateVariability: "millisecond",
      bloodPressure: "mmHg",
      bloodGlucose: "mg/dL",
      bodyTemperature: "celsius",
      height: "centimeter",
      flightsClimbed: "count",
      exerciseTime: "minute",
      distanceCycling: "meter",
      bodyFat: "percent",
      basalBodyTemperature: "celsius",
      basalCalories: "kilocalorie",
      totalCalories: "kilocalorie",
      mindfulness: "minute",
      vo2Max: "milliliterPerKilogramPerMinute",
    };
    return map[type] ?? null;
  }

  /** Unités attendues par POST /health/sync (backend ne convertit pas). */
  function canonicalUnit(dataType, unitFromSample) {
    const raw = unitFromSample ?? defaultUnit(dataType);
    if (!raw) return defaultUnit(dataType);
    const aliases = {
      ms: "millisecond",
      millisecond: "millisecond",
      milliseconds: "millisecond",
      "count/min": "bpm",
      "/min": "bpm",
      bpm: "bpm",
      percent: "percent",
      kilocalorie: "kilocalorie",
      kcal: "kilocalorie",
      meter: "meter",
      minute: "minute",
      min: "minute",
      count: "count",
      "ml/min/kg": "milliliterPerKilogramPerMinute",
      milliliterperkilogramperminute: "milliliterPerKilogramPerMinute",
    };
    return aliases[raw] ?? raw;
  }

  function intervalMinutes(sample) {
    const start = sample?.startDate ?? sample?.start_date;
    const end = sample?.endDate ?? sample?.end_date;
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return ms > 0 ? ms / 60000 : null;
  }

  /** Sommeil = durée en minutes (Capgo peut renvoyer durationMinutes: 0 — utiliser start/end). */
  function sleepMinutesFromSample(sample) {
    const ivs = extractSleepIntervalsFromRaw(sample);
    if (ivs.length > 0) {
      const ms = mergedIntervalMs(ivs);
      if (ms > 0) return ms / 60000;
    }
    const stages = sample?.stages;
    if (Array.isArray(stages) && stages.length > 0) {
      let fromStages = 0;
      for (const st of stages) {
        if (!isAsleepStageName(st?.stage ?? st?.name ?? st?.sleepState)) continue;
        const mins = stageIntervalMinutes(st);
        if (mins != null && mins > 0) fromStages += mins;
      }
      if (fromStages > 0) return fromStages;
    }
    const interval = intervalMinutes(sample);
    if (interval != null && interval > 0) return interval;
    const sleepState = normalizeSleepToken(sample?.sleepState ?? sample?.sleep_state);
    if (isAsleepStageName(sleepState) || !sleepState) {
      const parent = sleepSampleInterval(sample);
      if (parent) return (parent.endMs - parent.startMs) / 60000;
    }
    const v = toNum(sample?.value);
    if (v != null && v > 0 && v < 24 * 60) return v;
    return null;
  }

  function normalizeMetricValue(dataType, raw) {
    const n = toNum(raw);
    if (n == null) return null;
    if (dataType === "oxygenSaturation" && n > 0 && n <= 1) return n * 100;
    return n;
  }

  /** Capgo renvoie platformId (UUID HealthKit) ; repli seulement si absent. */
  function resolvePlatformId(record, fallbackKey) {
    const raw =
      record?.platformId ??
      record?.id ??
      record?.uuid ??
      record?.UUID ??
      null;
    if (raw != null && String(raw).length > 0) {
      return String(raw).slice(0, 255);
    }
    log(`platformId synthétique (${fallbackKey}) — plugin sans UUID`);
    return String(fallbackKey).slice(0, 255);
  }

  function clientOsVersion() {
    if (typeof window !== "undefined" && window.__pcpOsVersion) {
      return String(window.__pcpOsVersion).slice(0, 50);
    }
    return String(navigator.userAgent || "ios").slice(0, 50);
  }

  function normalizeWorkout(w) {
    const startDate = w?.startDate ?? null;
    const endDate = w?.endDate ?? null;
    const workoutType = w?.workoutType ?? w?.activityType ?? "unknown";
    const platformId = resolvePlatformId(
      w,
      `workout|${workoutType}|${startDate ?? "na"}|${endDate ?? "na"}`,
    );
    return {
      workoutType,
      duration: toIntOrNull(w?.duration),
      totalEnergyBurned: toNum(w?.totalEnergyBurned),
      totalDistance: toNum(w?.totalDistance),
      startDate,
      endDate,
      sourceId: w?.sourceId ?? w?.source_id ?? null,
      sourceName: w?.sourceName ?? w?.source_name ?? null,
      platformId,
    };
  }

  /**
   * Contrat v1 sommeil : 1 segment = 1 sample, champ `stage` brut OS (sans mapping).
   * Si Capgo renvoie stages[], on éclate ; sinon sleepState devient stage.
   */
  function buildSleepStageSample(sample, stageRaw, startDate, endDate, parentPlatformId, segmentKey) {
    if (!startDate || !endDate) return null;
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const value = (endMs - startMs) / 60000;
    if (value < 0.01) return null;

    const sourceName = sample.sourceName ?? sample.source_name ?? sample.sourceId ?? null;
    const sourceId = sample.sourceId ?? sample.source_id ?? null;
    const stageStr = stageRaw != null && String(stageRaw).length > 0 ? String(stageRaw) : null;
    const fallbackKey = `sleep|${sourceId ?? sourceName ?? "unknown"}|${startDate}|${endDate}|${stageStr ?? "asleep"}|${segmentKey}`;
    const platformId = parentPlatformId
      ? `${String(parentPlatformId).slice(0, 200)}::${segmentKey}`.slice(0, 255)
      : resolvePlatformId(sample, fallbackKey);

    const out = {
      dataType: "sleep",
      value,
      unit: canonicalUnit("sleep", sample.unit),
      startDate,
      endDate,
      sourceId,
      sourceName,
      platformId,
    };
    if (stageStr) out.stage = stageStr;
    return out;
  }

  function normalizeSleepSamples(sample) {
    if (!sample || typeof sample !== "object") return [];
    const parentPid = sample.platformId ?? sample.id ?? null;
    const stages = sample.stages;

    if (Array.isArray(stages) && stages.length > 0) {
      const out = [];
      stages.forEach((st, idx) => {
        const stageRaw = st?.stage ?? st?.name ?? st?.sleepState;
        const startDate = st?.startDate ?? st?.start_date ?? sample.startDate ?? sample.start_date;
        let endDate = st?.endDate ?? st?.end_date;
        if (!endDate && startDate) {
          const mins = stageIntervalMinutes(st);
          if (mins != null && mins > 0) {
            endDate = new Date(new Date(startDate).getTime() + mins * 60000).toISOString();
          }
        }
        endDate = endDate ?? sample.endDate ?? sample.end_date ?? startDate;
        const norm = buildSleepStageSample(
          sample,
          stageRaw,
          startDate,
          endDate,
          parentPid,
          `st${idx}|${startDate ?? idx}`,
        );
        if (norm) out.push(norm);
      });
      return out;
    }

    const startDate = sample.startDate ?? sample.start_date ?? null;
    const endDate = sample.endDate ?? sample.end_date ?? startDate;
    const stageRaw = sample.sleepState ?? sample.sleep_state ?? null;
    const norm = buildSleepStageSample(sample, stageRaw, startDate, endDate, parentPid, "seg0");
    return norm ? [norm] : [];
  }

  function normalizeSample(dataType, sample) {
    if (!sample || typeof sample !== "object") return null;
    const startDate = sample.startDate ?? sample.start_date ?? null;
    const endDate = sample.endDate ?? sample.end_date ?? startDate;
    if (!startDate || !endDate) return null;

    let value = null;
    if (dataType === "bloodPressure") {
      value = toNum(sample.systolic ?? sample.systolicValue);
    } else if (dataType === "sleep") {
      return null;
    } else if (dataType === "mindfulness" || dataType === "exerciseTime") {
      value = normalizeMetricValue(dataType, sample.value) ?? intervalMinutes(sample);
    } else if (
      dataType === "oxygenSaturation" ||
      dataType === "restingHeartRate" ||
      dataType === "heartRateVariability" ||
      dataType === "respiratoryRate" ||
      dataType === "bodyTemperature" ||
      dataType === "heartRate"
    ) {
      value = normalizeMetricValue(dataType, sample.value);
    } else {
      value = toNum(sample.value);
    }

    if (value == null || !Number.isFinite(value) || value < 0) return null;

    const sourceName = sample.sourceName ?? sample.source_name ?? sample.sourceId ?? null;
    const sourceId = sample.sourceId ?? sample.source_id ?? null;
    const platformId = resolvePlatformId(
      sample,
      `${dataType}|${sourceId ?? sourceName ?? "unknown"}|${startDate}|${endDate}`,
    );

    const out = {
      dataType,
      value,
      unit: canonicalUnit(dataType, sample.unit),
      startDate,
      endDate,
      sourceId,
      sourceName,
      platformId,
    };
    if (sample.origin) {
      out.origin = sample.origin;
    }
    if (sample.origin && dataType === "bodyTemperature") {
      out.hkType = sample.origin;
    }
    if (dataType === "bloodPressure") {
      const diastolic = toNum(sample.diastolic ?? sample.diastolicValue);
      if (diastolic != null) out.diastolic = diastolic;
    }
    return out;
  }

  /** File d'attente POST séquentielle (évite 12 requêtes parallèles côté serveur). */
  function createPostQueue(initialToken) {
    let chain = Promise.resolve({ ok: true, token: initialToken });
    let authToken = initialToken;
    return {
      push(label, payload) {
        let result;
        chain = chain.then(async () => {
          result = await postHealthSyncWithRetry(authToken, payload, label, { authToken });
          if (result?.token) authToken = result.token;
          return result;
        });
        return chain.then(() => result);
      },
      getToken() {
        return authToken;
      },
    };
  }

  function buildSyncBasePayload({
    syncId,
    startIso,
    endIso,
    pluginVersion,
    readGranted,
    readDenied,
    errors,
    hasQueryAggregated,
    strategy,
  }) {
    return {
      schema_version: 1,
      sync_id: syncId,
      synced_at: new Date().toISOString(),
      client: {
        app: "com.pcpinnov.pcpttherapy",
        app_version: "1.0.0",
        platform: "ios",
        plugin: "@capgo/capacitor-health",
        plugin_version: pluginVersion,
        os_version: clientOsVersion(),
      },
      source: "healthkit",
      window: { start_date: startIso, end_date: endIso },
      authorization: { read_granted: dedupe(readGranted), read_denied: dedupe(readDenied) },
      fetch: {
        strategy,
        limits: {
          per_type_page_size: SAMPLE_PAGE_SIZE,
          per_type_page_size_high: SAMPLE_PAGE_SIZE_HIGH,
          max_sample_pages: MAX_SAMPLE_PAGES,
          workout_page_size: WORKOUT_PAGE_SIZE,
          date_chunk_days: DATE_CHUNK_DAYS,
          date_chunk_types: [...DATE_CHUNK_READ_TYPES],
          dense_stream_post_bytes: MAX_DENSE_STREAM_POST_BYTES,
          dense_stream_max_samples: MAX_DENSE_STREAM_SAMPLES,
          dense_stream_types: [...DENSE_STREAM_POST_TYPES],
        },
        partial: Object.keys(errors).length > 0,
        errors,
      },
    };
  }

  function daysToMs(days) {
    return days * MS_PER_DAY;
  }

  function hoursToMs(hours) {
    return hours * MS_PER_HOUR;
  }

  function syncWindowDays(startDate, endDate) {
    return Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY));
  }

  /**
   * Fenêtre incrémentale : max(48 h, dernière sync − 24 h overlap).
   * Sync fréquente → ~2 j ; absence 4 j → ~5 j (rattrapage automatique).
   */
  function computeIncrementalWindow(lastDataSyncMs, endDate = new Date()) {
    const endMs = endDate.getTime();
    const minStartMs = endMs - hoursToMs(INCREMENTAL_LOOKBACK_HOURS);
    const overlapStartMs =
      lastDataSyncMs > 0 ? lastDataSyncMs - hoursToMs(INCREMENTAL_OVERLAP_HOURS) : minStartMs;
    const startMs = Math.min(minStartMs, overlapStartMs);
    const gapHours =
      lastDataSyncMs > 0 ? Math.round(((endMs - lastDataSyncMs) / MS_PER_HOUR) * 10) / 10 : null;
    const extendedByGap = lastDataSyncMs > 0 && overlapStartMs < minStartMs;
    return {
      startDate: new Date(startMs),
      endDate,
      windowDays: syncWindowDays(new Date(startMs), endDate),
      gapHours,
      minLookbackHours: INCREMENTAL_LOOKBACK_HOURS,
      overlapHours: INCREMENTAL_OVERLAP_HOURS,
      extendedByGap,
    };
  }

  /** Découpe une fenêtre en tranches (index 0 = plus récent). */
  function buildHistoricalSlices(startDate, endDate, sliceDays = DATE_CHUNK_DAYS) {
    const startMs = startDate.getTime();
    let endMs = endDate.getTime();
    const slices = [];
    let sliceIndex = 0;
    while (endMs > startMs) {
      const sliceStartMs = Math.max(startMs, endMs - sliceDays * MS_PER_DAY);
      slices.push({
        startDate: new Date(sliceStartMs),
        endDate: new Date(endMs),
        sliceIndex,
      });
      endMs = sliceStartMs - 1;
      sliceIndex += 1;
    }
    return slices;
  }

  function loadSliceCheckpoint(key, token) {
    try {
      const raw = getSyncScopedItem(key, token);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(
        Array.isArray(parsed.doneIndexes) ? parsed.doneIndexes.map((n) => Number(n)) : [],
      );
    } catch (_) {
      return new Set();
    }
  }

  function saveSliceCheckpoint(key, token, doneIndexes) {
    setSyncScopedItem(
      key,
      JSON.stringify({ doneIndexes: [...doneIndexes].sort((a, b) => a - b), updatedAt: Date.now() }),
      token,
    );
  }

  function clearSliceCheckpoint(key, token) {
    const pid = resolveSyncPatientId(token);
    if (pid) sessionStorage.removeItem(scopedSyncKey(key, pid));
  }

  function loadHistoricalCheckpoint(token) {
    return loadSliceCheckpoint(HISTORICAL_CHECKPOINT_KEY, token);
  }

  function saveHistoricalCheckpoint(token, doneIndexes) {
    saveSliceCheckpoint(HISTORICAL_CHECKPOINT_KEY, token, doneIndexes);
  }

  function clearHistoricalCheckpoint(token) {
    clearSliceCheckpoint(HISTORICAL_CHECKPOINT_KEY, token);
  }

  function loadDailyExtendedCheckpoint(token) {
    return loadSliceCheckpoint(DAILY_EXTENDED_CHECKPOINT_KEY, token);
  }

  function saveDailyExtendedCheckpoint(token, doneIndexes) {
    saveSliceCheckpoint(DAILY_EXTENDED_CHECKPOINT_KEY, token, doneIndexes);
  }

  function clearDailyExtendedCheckpoint(token) {
    clearSliceCheckpoint(DAILY_EXTENDED_CHECKPOINT_KEY, token);
  }

  /**
   * Backfill historique par tranches 10 j : checkpoint après chaque succès,
   * reprise au swipe, échec strict si pagination HealthKit tronquée.
   */
  async function syncHistoricalWithCheckpoints(Health, startDate, endDate, token, options = {}) {
    const phaseLabel = options.bg ? "bg-historical" : "historical";
    const slices = buildHistoricalSlices(startDate, endDate);
    const doneIndexes = loadHistoricalCheckpoint(token);
    const pending = slices.filter((s) => !doneIndexes.has(s.sliceIndex));
    const total = slices.length;

    if (doneIndexes.size > 0) {
      log(`Historique — reprise ${doneIndexes.size}/${total} tranche(s) déjà validée(s)`);
      log(`[sync-session] HISTORICAL_CHECKPOINT resume ${doneIndexes.size}/${total}`);
    }

    if (total > 0 && pending.length === 0) {
      log("Historique — toutes les tranches checkpointées");
      clearHistoricalCheckpoint(token);
      return {
        ok: true,
        token,
        sentSamples: 0,
        sentWorkouts: 0,
        sentAggregates: 0,
        batched: false,
        batch_count: 0,
        streaming: true,
        historicalComplete: true,
      };
    }

    let activeToken = token;
    let merged = null;

    for (let i = 0; i < pending.length; i++) {
      const slice = pending[i];
      const sliceNum = slice.sliceIndex + 1;
      const windowDays = syncWindowDays(slice.startDate, slice.endDate);
      const fromDay = slice.startDate.toISOString().slice(0, 10);
      const toDay = slice.endDate.toISOString().slice(0, 10);
      log(`Historique tranche ${sliceNum}/${total} (${windowDays}j, ${fromDay} → ${toDay})…`);
      log(`[sync-session] HISTORICAL_SLICE ${sliceNum}/${total} ${windowDays}j`);

      const result = await collectAndStreamPost(Health, slice.startDate, slice.endDate, activeToken, {
        manual: !!options.manual,
        phase: phaseLabel,
        strictSlice: true,
        sliceIndex: slice.sliceIndex,
        sliceNum,
        sliceTotal: total,
      });
      activeToken = result.token ?? activeToken;
      merged = mergeStreamPhaseResults(merged, result);

      if (!result.ok) {
        log(`Historique tranche ${sliceNum}/${total} échec — reprise au prochain essai`);
        log(`[sync-session] HISTORICAL_SLICE_FAIL ${sliceNum}/${total}`);
        return { ...result, token: activeToken, batch_count: merged?.batch_count ?? result.batch_count };
      }

      doneIndexes.add(slice.sliceIndex);
      saveHistoricalCheckpoint(activeToken, doneIndexes);
      log(`[sync-session] HISTORICAL_SLICE_OK ${sliceNum}/${total}`);
    }

    clearHistoricalCheckpoint(activeToken);
    log(`Historique — ${total} tranche(s) validées (checkpoint effacé)`);
    log(`[sync-session] HISTORICAL_CHECKPOINT complete ${total}`);

    return {
      ...(merged || { ok: true }),
      ok: true,
      token: activeToken,
      historicalComplete: true,
    };
  }

  /**
   * Backfill agrégats journaliers j 91–365 (+ workouts) par tranches 30 j.
   * Pas de samples intraday — léger (~365 points / mesure).
   */
  async function syncDailyExtendedWithCheckpoints(Health, startDate, endDate, token, options = {}) {
    const phaseLabel = options.bg ? "bg-daily-extended" : "daily-extended";
    const slices = buildHistoricalSlices(startDate, endDate, DAILY_EXTENDED_SLICE_DAYS);
    const doneIndexes = loadDailyExtendedCheckpoint(token);
    const pending = slices.filter((s) => !doneIndexes.has(s.sliceIndex));
    const total = slices.length;

    if (doneIndexes.size > 0) {
      log(`Agrégats 1 an — reprise ${doneIndexes.size}/${total} tranche(s) déjà validée(s)`);
      log(`[sync-session] DAILY_EXTENDED_CHECKPOINT resume ${doneIndexes.size}/${total}`);
    }

    if (total > 0 && pending.length === 0) {
      log("Agrégats 1 an — toutes les tranches checkpointées");
      clearDailyExtendedCheckpoint(token);
      return {
        ok: true,
        token,
        sentSamples: 0,
        sentWorkouts: 0,
        sentAggregates: 0,
        batched: false,
        batch_count: 0,
        streaming: true,
        dailyExtendedComplete: true,
      };
    }

    let activeToken = token;
    let merged = null;

    for (let i = 0; i < pending.length; i++) {
      const slice = pending[i];
      const sliceNum = slice.sliceIndex + 1;
      const windowDays = syncWindowDays(slice.startDate, slice.endDate);
      const fromDay = slice.startDate.toISOString().slice(0, 10);
      const toDay = slice.endDate.toISOString().slice(0, 10);
      log(`Agrégats 1 an tranche ${sliceNum}/${total} (${windowDays}j, ${fromDay} → ${toDay})…`);
      log(`[sync-session] DAILY_EXTENDED_SLICE ${sliceNum}/${total} ${windowDays}j`);

      const result = await collectAndStreamPost(Health, slice.startDate, slice.endDate, activeToken, {
        manual: !!options.manual,
        phase: phaseLabel,
        dailyExtendedOnly: true,
        sliceNum,
        sliceTotal: total,
      });
      activeToken = result.token ?? activeToken;
      merged = mergeStreamPhaseResults(merged, result);

      if (!result.ok) {
        log(`Agrégats 1 an tranche ${sliceNum}/${total} échec — reprise au prochain essai`);
        log(`[sync-session] DAILY_EXTENDED_SLICE_FAIL ${sliceNum}/${total}`);
        return { ...result, token: activeToken, batch_count: merged?.batch_count ?? result.batch_count };
      }

      doneIndexes.add(slice.sliceIndex);
      saveDailyExtendedCheckpoint(activeToken, doneIndexes);
      log(`[sync-session] DAILY_EXTENDED_SLICE_OK ${sliceNum}/${total}`);
    }

    clearDailyExtendedCheckpoint(activeToken);
    log(`Agrégats 1 an — ${total} tranche(s) validées (checkpoint effacé)`);
    log(`[sync-session] DAILY_EXTENDED_CHECKPOINT complete ${total}`);

    return {
      ...(merged || { ok: true }),
      ok: true,
      token: activeToken,
      dailyExtendedComplete: true,
    };
  }

  /**
   * Steady state : 48 h (+ overlap). 1ère sync / backfill incomplet : récent d'abord, puis 90 j intraday.
   * `force` = contourner l'intervalle 6 h uniquement — pas forcer le backfill complet.
   */
  function resolveSyncPlan(options) {
    const token = options?.token;
    ensureSyncPatientScope(token);
    const endDate = new Date();
    const lastDataSync = parseInt(getSyncScopedItem(LAST_DATA_SYNC_KEY, token) || "0", 10);
    let fullBackfillAt = parseInt(getSyncScopedItem(FULL_BACKFILL_KEY, token) || "0", 10);
    const forceFull = !!(options && options.fullLookback);

    // Mise à jour app : sync OK antérieure sur ce compte → pas de re-téléchargement intraday complet.
    // Ne pas migrer si le backfill historical est encore en cours (phase 7 j OK ≠ 90 j terminés).
    if (
      fullBackfillAt <= 0 &&
      lastDataSync > 0 &&
      !forceFull &&
      !options?._migratedBackfill &&
      !isHistoricalBackfillPending(token)
    ) {
      try {
        setSyncScopedItem(FULL_BACKFILL_KEY, String(lastDataSync), token);
      } catch (_) {}
      fullBackfillAt = lastDataSync;
      log("Backfill historique déjà effectué (migration) — mode incrémental");
      return resolveSyncPlan({ ...options, token, _migratedBackfill: true });
    }

    if (fullBackfillAt > 0 && !forceFull) {
      const win = computeIncrementalWindow(lastDataSync, endDate);
      return {
        mode: "incremental",
        phases: [{ startDate: win.startDate, endDate, label: "incremental" }],
        incrementalWindow: win,
      };
    }

    if (isHistoricalBackfillPending(token) && !window.__pcpHealthBackfillRunning) {
      const dailyStart = new Date(endDate.getTime() - daysToMs(DAILY_AGGREGATE_LOOKBACK_DAYS));
      const sampleStart = new Date(endDate.getTime() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS));
      const recentStart = new Date(endDate.getTime() - daysToMs(PRIORITY_LOOKBACK_DAYS));
      const phases = [];
      appendBackfillPhases(phases, dailyStart, sampleStart, recentStart);
      if (phases.length > 0) {
        log("Backfill historique interrompu — reprise par tranches");
        return { mode: "backfill_resume", phases };
      }
    }

    const dailyStart = new Date(endDate.getTime() - daysToMs(DAILY_AGGREGATE_LOOKBACK_DAYS));
    const sampleStart = new Date(endDate.getTime() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS));
    const recentMs =
      lastDataSync > 0 ? hoursToMs(INCREMENTAL_LOOKBACK_HOURS) : daysToMs(PRIORITY_LOOKBACK_DAYS);
    const recentStart = new Date(endDate.getTime() - recentMs);
    const phases = [
      {
        startDate: recentStart,
        endDate,
        label: lastDataSync > 0 ? "catch-up" : `priority-${PRIORITY_LOOKBACK_DAYS}d`,
      },
    ];
    appendBackfillPhases(phases, dailyStart, sampleStart, recentStart);
    return {
      mode: fullBackfillAt > 0 ? "backfill_resume" : "phased_initial",
      phases,
    };
  }

  /**
   * Backfill arrière-plan : historical (j 8–90) puis daily-extended (j 91–365).
   * Le recovery sur j 8–90 est corrigé en fin de backfill via maybeRepairRecoveryRescore
   * (re-post vitaux nuit + rescoring backend), pas via l'ordre des phases.
   */
  function appendBackfillPhases(phases, dailyStart, sampleStart, recentStart) {
    if (sampleStart.getTime() < recentStart.getTime()) {
      phases.push({ startDate: sampleStart, endDate: recentStart, label: "historical" });
    }
    if (dailyStart.getTime() < sampleStart.getTime()) {
      phases.push({ startDate: dailyStart, endDate: sampleStart, label: "daily-extended" });
    }
  }

  /** Rattrapage 1 an pour comptes déjà backfillés à 60 j (migration Cyrille). */
  async function maybeAppendDailyExtendedCatchup(token, syncPlan, options) {
    if (!syncPlan || options?.fullLookback) return syncPlan;
    if (syncPlan.mode !== "incremental") return syncPlan;
    const probe = window.PcpHealthServerBackfillProbe;
    if (!probe?.probeServerHistoricalCoverage) return syncPlan;
    try {
      const coverage = await probe.probeServerHistoricalCoverage(token, {
        lookbackDays: DAILY_AGGREGATE_LOOKBACK_DAYS,
      });
      const minSpan = probe.MIN_SPAN_DAYS ?? 330;
      if ((coverage.spanDays ?? 0) >= minSpan) return syncPlan;
      const endDate = new Date();
      const dailyStart = new Date(endDate.getTime() - daysToMs(DAILY_AGGREGATE_LOOKBACK_DAYS));
      const sampleStart = new Date(endDate.getTime() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS));
      if (dailyStart.getTime() >= sampleStart.getTime()) return syncPlan;
      log(
        `Rattrapage agrégats 1 an — span serveur ${coverage.spanDays ?? 0}j < ${minSpan}j (oldest=${coverage.oldestDay ?? "—"})`,
      );
      log("[sync-session] DAILY_EXTENDED_CATCHUP span=" + (coverage.spanDays ?? 0));
      return {
        mode: "daily_extended_catchup",
        phases: [{ startDate: dailyStart, endDate: sampleStart, label: "daily-extended" }],
      };
    } catch (err) {
      log(`Probe rattrapage 1 an: ${formatSyncError(err, "daily-catchup")}`);
      return syncPlan;
    }
  }

  function mergeStreamPhaseResults(acc, phaseResult) {
    if (!acc) {
      return {
        sentSamples: phaseResult.sentSamples || 0,
        sentWorkouts: phaseResult.sentWorkouts || 0,
        sentAggregates: phaseResult.sentAggregates || 0,
        body: phaseResult.body,
        batch_count: phaseResult.batch_count || 0,
        streaming: !!phaseResult.streaming,
        batched: !!phaseResult.batched,
      };
    }
    return {
      sentSamples: acc.sentSamples + (phaseResult.sentSamples || 0),
      sentWorkouts: acc.sentWorkouts + (phaseResult.sentWorkouts || 0),
      sentAggregates: Math.max(acc.sentAggregates, phaseResult.sentAggregates || 0),
      body: phaseResult.body ?? acc.body,
      batch_count: (acc.batch_count || 0) + (phaseResult.batch_count || 0),
      streaming: acc.streaming || !!phaseResult.streaming,
      batched: acc.batched || !!phaseResult.batched,
    };
  }

  /** Midi local — pas/calories (totaux journaliers, pas de scoring nocturne). */
  function dailyNoonIso(dayKey) {
    const d = new Date(`${dayKey}T12:00:00`);
    return Number.isNaN(d.getTime()) ? `${dayKey}T12:00:00.000Z` : d.toISOString();
  }

  /** 04:00 UTC — repli backend _NIGHT_FALLBACK (00:00–10:00 UTC → jour de réveil). */
  function dailyWakeFallbackIso(dayKey) {
    return `${dayKey}T04:00:00.000Z`;
  }

  function addDayKey(dayKey, deltaDays) {
    const d = new Date(`${dayKey}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return dayKey;
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  }

  /** Jour de réveil (UTC) — aligné sur health_service._night_values_by_day. */
  function vitalWakeDayFromIso(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return localDayKey(iso);
    const h = d.getUTCHours();
    const day = localDayKey(iso);
    if (h >= 20) return addDayKey(day, 1);
    if (h < 10) return day;
    return day;
  }

  function isNonSleepStageForVitalIndex(stageName) {
    const n = normalizeSleepToken(stageName ?? "");
    if (!n) return false;
    if (isInBedStageName(n) || n.includes("awake")) return true;
    return false;
  }

  /** wakeDay → ISO au milieu du plus long segment sommeil (pour attribution nocturne backend). */
  function buildWakeDayNightTimestampIndex(sleepSamples) {
    const best = new Map();
    for (const s of sleepSamples ?? []) {
      const stage = s?.extra?.stage ?? s?.stage ?? null;
      if (isNonSleepStageForVitalIndex(stage)) continue;
      const startMs = new Date(s.startDate).getTime();
      const endMs = new Date(s.endDate ?? s.startDate).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      const wakeDay = localDayKey(new Date(endMs).toISOString());
      const dur = endMs - startMs;
      const prev = best.get(wakeDay);
      if (!prev || dur > prev.dur) {
        best.set(wakeDay, { dur, iso: new Date(startMs + dur / 2).toISOString() });
      }
    }
    const out = {};
    for (const [k, v] of best) out[k] = v.iso;
    return out;
  }

  function resolveVitalNightIso(wakeDay, nightIndex) {
    if (nightIndex?.[wakeDay]) return nightIndex[wakeDay];
    return dailyWakeFallbackIso(wakeDay);
  }

  /** Plus long segment sommeil réel par jour de réveil (hors inBed/awake). */
  function pickBestSleepSegmentPerWakeDay(stagedSleep) {
    const best = new Map();
    for (const s of stagedSleep ?? []) {
      const stage = s?.extra?.stage ?? s?.stage ?? null;
      if (isNonSleepStageForVitalIndex(stage)) continue;
      const startMs = new Date(s.startDate).getTime();
      const endMs = new Date(s.endDate ?? s.startDate).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      const wakeDay = localDayKey(new Date(endMs).toISOString());
      const dur = endMs - startMs;
      const prev = best.get(wakeDay);
      if (!prev || dur > prev.dur) best.set(wakeDay, { dur, sample: s });
    }
    const out = new Map();
    for (const [k, v] of best) out.set(k, v.sample);
    return out;
  }

  /**
   * 1 segment sommeil par jour de réveil des vitaux réparés — permet au backend
   * d'attribuer HRV/resp/SpO₂ nocturnes même si le sommeil n'avait pas été syncé.
   */
  function buildCompanionSleepSamplesForWakeDays(wakeDays, stagedSleep) {
    const byWake = pickBestSleepSegmentPerWakeDay(stagedSleep);
    const out = [];
    for (const wakeDay of wakeDays) {
      const existing = byWake.get(wakeDay);
      if (existing) {
        out.push(existing);
        continue;
      }
      const startDate = `${addDayKey(wakeDay, -1)}T22:00:00.000Z`;
      const endDate = `${wakeDay}T10:00:00.000Z`;
      const norm = buildSleepStageSample(
        { sourceName: "healthkit" },
        "asleep",
        startDate,
        endDate,
        `sleep|companion|${wakeDay}`,
        "companion",
      );
      if (norm) out.push(norm);
    }
    return out;
  }

  async function loadStagedSleepForCompanion(Health, startIso, endIsoQuery) {
    const sleepRead = await readAllSleepSamples(Health, startIso, endIsoQuery, { light: true });
    return buildSleepCompactSamplesFromRaw(sleepRead.raw ?? [], sleepRead.dailyRows ?? [], {
      historicalLight: false,
    });
  }

  async function buildRecoveryCompanionSleepForSlice(Health, slice, repairTypes) {
    const startIso = slice.startDate.toISOString();
    const endIsoQuery = new Date(slice.endDate.getTime() + 60 * 1000).toISOString();
    const stagedSleep = await loadStagedSleepForCompanion(Health, startIso, endIsoQuery);
    const nightIndex = buildWakeDayNightTimestampIndex(stagedSleep);
    const wakeDays = new Set();
    for (const type of repairTypes) {
      const chunkRead = await readAllSamplesByDateChunks(Health, type, startIso, endIsoQuery);
      const collapsed = collapseVitalSamplesToDailySynthetic(
        chunkRead.samples ?? [],
        type,
        nightIndex,
      );
      for (const s of collapsed) wakeDays.add(vitalWakeDayFromIso(s.startDate));
    }
    return buildCompanionSleepSamplesForWakeDays([...wakeDays], stagedSleep);
  }

  async function loadVitalNightIndex(Health, startIso, endIsoQuery, historicalLight, sleepLight) {
    try {
      const sleepRead = await readAllSleepSamples(Health, startIso, endIsoQuery, {
        light: !!sleepLight,
      });
      let sleepSamples = [];
      if (historicalLight || sleepRead.dailyRows?.length || sleepRead.raw?.length) {
        sleepSamples = buildSleepCompactSamplesFromRaw(sleepRead.raw ?? [], sleepRead.dailyRows ?? [], {
          historicalLight,
        });
      } else if (sleepRead.normalized?.length) {
        sleepSamples = sleepRead.normalized;
      }
      return buildWakeDayNightTimestampIndex(sleepSamples);
    } catch (_) {
      return {};
    }
  }

  function addCalendarDays(dayStr, delta) {
    const parts = String(dayStr).split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return dayStr;
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    dt.setDate(dt.getDate() + delta);
    return localDayKey(dt.toISOString());
  }

  function wakeDaysToReadWindow(wakeDays) {
    if (!wakeDays?.length) return null;
    const sorted = [...wakeDays].sort();
    const minDay = sorted[0];
    const maxDay = sorted[sorted.length - 1];
    return {
      startIso: new Date(`${addCalendarDays(minDay, -1)}T12:00:00.000Z`).toISOString(),
      endIso: new Date(`${addCalendarDays(maxDay, 1)}T14:00:00.000Z`).toISOString(),
    };
  }

  function filterSleepSamplesForWakeDays(samples, wakeDaySet) {
    if (!wakeDaySet?.size) return samples ?? [];
    return (samples ?? []).filter((s) => {
      const wake = localDayKey(s.endDate ?? s.end_at ?? s.endAt);
      return wake && wakeDaySet.has(wake);
    });
  }

  let __pcpSleepStagesRepairRunning = false;
  const HISTORICAL_LIGHT_PHASES = new Set(["historical", "bg-historical"]);
  const DAILY_EXTENDED_PHASES = new Set(["daily-extended", "bg-daily-extended"]);
  const INCREMENTAL_COMPACT_PHASES = new Set(["incremental"]);

  function isDailyExtendedPhase(phaseLabel) {
    return DAILY_EXTENDED_PHASES.has(String(phaseLabel ?? ""));
  }

  /** Jours 8–90 : agrégats + 1 sample/jour (vitaux/sommeil) — pas de segments bruts denses. */
  function isHistoricalLightPhase(phaseLabel) {
    return HISTORICAL_LIGHT_PHASES.has(String(phaseLabel ?? ""));
  }

  /** Steady state : vitaux denses + sommeil compactés (1 pt/jour) — Watch très dense. */
  function isIncrementalCompactPhase(phaseLabel) {
    return INCREMENTAL_COMPACT_PHASES.has(String(phaseLabel ?? ""));
  }

  /**
   * Pas/cal/FC repos : totaux via daily_aggregates + samples |agg| scoring (upsert backend).
   * Phases : incrémental, 7 j initiaux, catch-up.
   */
  function isActivityAggregatesOnlyPhase(phaseLabel) {
    const label = String(phaseLabel ?? "");
    if (INCREMENTAL_COMPACT_PHASES.has(label)) return true;
    if (label === `priority-${PRIORITY_LOOKBACK_DAYS}d` || label === "catch-up") return true;
    return false;
  }

  function useVitalCompactMode(phaseLabel) {
    return isHistoricalLightPhase(phaseLabel) || isIncrementalCompactPhase(phaseLabel);
  }

  function useSleepCompactMode(phaseLabel) {
    return isHistoricalLightPhase(phaseLabel) || isIncrementalCompactPhase(phaseLabel);
  }

  function medianOf(nums) {
    if (!nums?.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function averageOf(nums) {
    if (!nums?.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  /**
   * Compresse des samples bruts en 1 point/jour (médiane HRV, moyenne resp/SpO₂/temp).
   * Aligné sur health_service._load_score_inputs (médiane log-HRV par jour).
   */
  function collapseVitalSamplesToDailySynthetic(samples, dataType, nightIndex) {
    const byWake = new Map();
    for (const s of samples ?? []) {
      const wakeDay = vitalWakeDayFromIso(s.startDate);
      if (!wakeDay || s.value == null) continue;
      if (!byWake.has(wakeDay)) byWake.set(wakeDay, []);
      byWake.get(wakeDay).push(s.value);
    }
    const out = [];
    for (const [wakeDay, vals] of byWake) {
      if (isFutureScoreRingDay(wakeDay)) continue;
      const val =
        dataType === "heartRateVariability" ? medianOf(vals) : averageOf(vals);
      if (val == null || !Number.isFinite(val) || val <= 0) continue;
      const startDate = resolveVitalNightIso(wakeDay, nightIndex);
      const norm = normalizeSample(dataType, {
        dataType,
        value: val,
        unit: defaultUnit(dataType),
        startDate,
        endDate: startDate,
        platformId: `${dataType}|agg|${wakeDay}`,
        sourceName: "healthkit",
      });
      if (norm) out.push(norm);
    }
    return out;
  }

  /** Vitaux j 91–365 : 1 sample/jour (saisies manuelles Santé incluses). */
  const DAILY_EXTENDED_VITAL_TYPES = [
    "heartRateVariability",
    "respiratoryRate",
    "oxygenSaturation",
    "bodyTemperature",
  ];

  async function readDailyExtendedVitalsCompact(
    Health,
    startIso,
    endIsoQuery,
    grantedSet,
    readGranted,
    errors,
    nightIndex,
  ) {
    const out = {};
    for (const type of DAILY_EXTENDED_VITAL_TYPES) {
      if (!grantedSet.has(type)) continue;
      try {
        if (!readGranted.includes(type)) readGranted.push(type);
        const chunkRead = await readAllSamplesByDateChunks(Health, type, startIso, endIsoQuery);
        const rawSamples = chunkRead.samples ?? [];
        let samples = collapseVitalSamplesToDailySynthetic(rawSamples, type, nightIndex);
        log(`  daily-extended ${type}: ${rawSamples.length} bruts → ${samples.length} jour(s)`);
        if (samples.length === 0 && rawSamples.length > 0) {
          log(`  daily-extended ${type}: repli samples bruts (${rawSamples.length})`);
          samples = filterNightVitalSamplesForPost(rawSamples, type);
        }
        if (samples.length > 0) out[type] = samples;
      } catch (err) {
        errors[type] = String(err?.message ?? err).slice(0, 500);
      }
    }
    return out;
  }

  /** Bucket stade pour fusion historique léger (REM / Deep / Core / Awake / InBed). */
  function canonicalSleepStageBucket(stageName) {
    const n = normalizeSleepToken(stageName);
    if (!n) return "Asleep";
    if (n.includes("rem")) return "REM";
    if (n.includes("deep")) return "Deep";
    if (n.includes("core") || n.includes("light")) return "Core";
    if (n.includes("awake")) return "Awake";
    if (isInBedStageName(n)) return "InBed";
    if (n.includes("asleep")) return "Asleep";
    return String(stageName);
  }

  /**
   * Historique 8–60 j : ~1–4 samples fusionnés/stade/nuit avec vrais horaires
   * (réparateur, constance, coucher/lever) sans envoyer tous les segments bruts.
   */
  function buildSleepCompactStagedSamplesFromRaw(rawList) {
    if (!Array.isArray(rawList) || rawList.length === 0) return [];

    const nights = clusterSleepRawIntoNights(rawList);
    const out = [];

    for (const nightSamples of nights) {
      const bySrc = new Map();
      for (const raw of nightSamples) {
        const src = String(raw?.sourceName ?? raw?.sourceId ?? "unknown");
        if (!bySrc.has(src)) bySrc.set(src, []);
        bySrc.get(src).push(raw);
      }

      let bestList = nightSamples;
      let bestPri = -1;
      for (const [src, list] of bySrc) {
        const pri = sleepSourcePriority(src);
        if (pri > bestPri) {
          bestPri = pri;
          bestList = list;
        }
      }

      const segments = [];
      for (const raw of bestList) {
        segments.push(...normalizeSleepSamples(raw));
      }
      if (!segments.length) continue;

      const byBucket = new Map();
      for (const seg of segments) {
        const bucket = canonicalSleepStageBucket(seg.stage);
        if (!byBucket.has(bucket)) byBucket.set(bucket, []);
        byBucket.get(bucket).push(seg);
      }

      let wakeDay = null;
      for (const seg of segments) {
        const endMs = new Date(seg.endDate).getTime();
        if (!Number.isFinite(endMs)) continue;
        const d = localDayKey(new Date(endMs).toISOString());
        if (!wakeDay || d > wakeDay) wakeDay = d;
      }
      if (!wakeDay) continue;

      for (const [bucket, segs] of byBucket) {
        const intervals = segs
          .map((seg) => ({
            startMs: new Date(seg.startDate).getTime(),
            endMs: new Date(seg.endDate).getTime(),
            seg,
          }))
          .filter((iv) => Number.isFinite(iv.startMs) && Number.isFinite(iv.endMs) && iv.endMs > iv.startMs)
          .sort((a, b) => a.startMs - b.startMs);

        const merged = [];
        for (const iv of intervals) {
          const last = merged[merged.length - 1];
          if (!last || iv.startMs > last.endMs + 60_000) {
            merged.push({ startMs: iv.startMs, endMs: iv.endMs, seg: iv.seg });
          } else {
            last.endMs = Math.max(last.endMs, iv.endMs);
          }
        }

        for (let mi = 0; mi < merged.length; mi++) {
          const m = merged[mi];
          const norm = buildSleepStageSample(
            m.seg,
            bucket,
            new Date(m.startMs).toISOString(),
            new Date(m.endMs).toISOString(),
            `sleep|hist|${wakeDay}`,
            `${bucket}|${mi}`,
          );
          if (norm) out.push(norm);
        }
      }
    }

    return out;
  }

  /** 1 sample/nuit (durée totale @ midi) — repli si HK ne fournit pas d'intervalles exploitables. */
  function buildSleepSyntheticFromDailyRows(dailyRows) {
    const samples = [];
    for (const row of dailyRows ?? []) {
      if (!row?.day) continue;
      const mins = Math.round(toNum(row.sleep_total_min) ?? 0);
      if (mins <= 0) continue;
      const startDate = dailyNoonIso(row.day);
      const endDate = new Date(new Date(startDate).getTime() + mins * 60000).toISOString();
      const norm = buildSleepStageSample(
        { sourceName: row.primary_source ?? "healthkit" },
        null,
        startDate,
        endDate,
        `sleep|agg|${row.day}`,
        "night",
      );
      if (norm) samples.push(norm);
    }
    return samples;
  }

  /**
   * Fenêtre horaire + durée endormie depuis bruts HK d'une nuit (1 source).
   * Horaires = min(start)→max(end) réels (y compris inBed sans stades).
   * Durée = intervalles endormis fusionnés, sinon total agrégé Santé.
   */
  function collectSleepNightMetrics(rawList, dailyByDay) {
    const asleepIntervals = [];
    let windowMinStart = Infinity;
    let windowMaxEnd = -Infinity;
    let hasWindow = false;

    for (const raw of rawList ?? []) {
      const state = normalizeSleepToken(raw?.sleepState ?? raw?.sleep_state);
      if (state.includes("awake")) continue;

      const asleep = extractSleepIntervalsFromRaw(raw);
      for (const iv of asleep) {
        asleepIntervals.push(iv);
        windowMinStart = Math.min(windowMinStart, iv.startMs);
        windowMaxEnd = Math.max(windowMaxEnd, iv.endMs);
        hasWindow = true;
      }
      if (asleep.length) continue;

      const iv = sleepSampleInterval(raw);
      if (!iv) continue;
      windowMinStart = Math.min(windowMinStart, iv.startMs);
      windowMaxEnd = Math.max(windowMaxEnd, iv.endMs);
      hasWindow = true;
    }

    if (!hasWindow) return null;

    const wakeDay = localDayKey(new Date(windowMaxEnd).toISOString());
    const asleepMs = mergedIntervalMs(asleepIntervals);
    const aggMin = wakeDay && dailyByDay?.get(wakeDay) ? Math.round(dailyByDay.get(wakeDay)) : 0;
    let asleepMin = asleepMs > 0 ? Math.round(asleepMs / 60000) : 0;
    if (asleepMin <= 0 && aggMin > 0) asleepMin = aggMin;
    if (asleepMin <= 0) {
      asleepMin = Math.round((windowMaxEnd - windowMinStart) / 60000);
    }
    if (!wakeDay || asleepMin <= 0) return null;

    return {
      wakeDay,
      asleepMin,
      startDate: new Date(windowMinStart).toISOString(),
      endDate: new Date(windowMaxEnd).toISOString(),
    };
  }

  /**
   * 1 sample/nuit avec vrais horaires HK (pas de midi synthétique).
   * value = minutes endormies (fusionnées ou agrégat Santé).
   */
  function buildSleepRealIntervalSamplesFromRaw(rawList, dailyRows) {
    if (!Array.isArray(rawList) || rawList.length === 0) return [];

    const dailyByDay = new Map();
    for (const row of dailyRows ?? []) {
      const mins = Math.round(toNum(row?.sleep_total_min) ?? 0);
      if (row?.day && mins > 0) dailyByDay.set(row.day, mins);
    }

    const nights = clusterSleepRawIntoNights(rawList);
    const out = [];

    for (const nightSamples of nights) {
      const bySrc = new Map();
      for (const raw of nightSamples) {
        const src = String(raw?.sourceName ?? raw?.sourceId ?? "unknown");
        if (!bySrc.has(src)) bySrc.set(src, []);
        bySrc.get(src).push(raw);
      }

      let bestMetrics = null;
      let bestPri = -1;
      let bestSource = "healthkit";

      for (const [src, list] of bySrc) {
        const metrics = collectSleepNightMetrics(list, dailyByDay);
        if (!metrics) continue;
        const pri = sleepSourcePriority(src);
        if (
          !bestMetrics ||
          pri > bestPri ||
          (pri === bestPri && metrics.asleepMin > bestMetrics.asleepMin)
        ) {
          bestPri = pri;
          bestMetrics = metrics;
          bestSource = src;
        }
      }

      if (!bestMetrics) continue;

      const norm = buildSleepStageSample(
        { sourceName: bestSource },
        null,
        bestMetrics.startDate,
        bestMetrics.endDate,
        `sleep|compact|${bestMetrics.wakeDay}`,
        "night",
      );
      if (norm) {
        norm.value = bestMetrics.asleepMin;
        out.push(norm);
      }
    }

    return out;
  }

  /** REM / Deep / Core — pas le seul bucket générique « Asleep » sans détail HK. */
  function hasDetailedSleepStages(samples) {
    for (const s of samples ?? []) {
      const bucket = canonicalSleepStageBucket(s.stage);
      if (bucket === "REM" || bucket === "Deep" || bucket === "Core") return true;
    }
    return false;
  }

  /**
   * historicalLight → stades compacts si dispo (réparateur j 8–60).
   * incremental compact → intervalles réels sauf vrais stades REM/Deep/Core.
   */
  function buildSleepCompactSamplesFromRaw(rawList, dailyRows, options = {}) {
    const historicalLight = options.historicalLight === true;
    const staged = buildSleepCompactStagedSamplesFromRaw(rawList ?? []);
    if (staged.length && (historicalLight || hasDetailedSleepStages(staged))) {
      return staged;
    }
    const real = buildSleepRealIntervalSamplesFromRaw(rawList ?? [], dailyRows ?? []);
    if (real.length) return real;
    if (staged.length) return staged;
    return buildSleepSyntheticFromDailyRows(dailyRows ?? []);
  }

  function describeSleepCompactPostMode(samples) {
    if (!samples?.length) return "aucun";
    if (samples.some((s) => String(s.platformId ?? "").startsWith("sleep|compact|"))) {
      return "intervalles réels";
    }
    if (hasDetailedSleepStages(samples)) return "stades compacts";
    if (samples.some((s) => String(s.platformId ?? "").startsWith("sleep|hist|"))) {
      return "asleep générique";
    }
    if (samples.some((s) => String(s.platformId ?? "").startsWith("sleep|agg|"))) {
      return "synthétique";
    }
    return "autre";
  }

  /**
   * queryAggregated fournit pas/calories/FC repos ; le backend rollup lit HealthSample.
   * Sans sample steps, un lot vitaux/sommeil seul peut effacer steps_total en base.
   */
  function buildScoringSamplesFromDailyAggregates(dailyList, nightIndex) {
    const specs = [
      { type: "steps", field: "steps_total", intValue: true },
      { type: "calories", field: "calories_total_kcal" },
      { type: "restingHeartRate", field: "resting_heart_rate_avg" },
    ];
    const out = {};
    for (const spec of specs) {
      const samples = [];
      for (const row of dailyList ?? []) {
        if (!row?.day) continue;
        if (!isPostableDailyAggregateRow(row)) continue;
        const val = toNum(row[spec.field]);
        if (val == null || val <= 0) continue;
        const sampleVal = spec.intValue ? Math.round(val) : val;
        const startDate =
          spec.type === "restingHeartRate"
            ? resolveVitalNightIso(row.day, nightIndex)
            : dailyNoonIso(row.day);
        const norm = normalizeSample(spec.type, {
          dataType: spec.type,
          value: sampleVal,
          unit: defaultUnit(spec.type),
          startDate,
          endDate: startDate,
          platformId: `${spec.type}|agg|${row.day}`,
          sourceName: row.primary_source ?? "healthkit",
        });
        if (norm) samples.push(norm);
      }
      if (samples.length > 0) {
        out[spec.type] = {
          data_type: spec.type,
          unit_default: defaultUnit(spec.type),
          sample_count: samples.length,
          samples,
        };
      }
    }
    return out;
  }

  function mergeScoringSamplesFromDailyAggregates(samplesByType, dailyList, nightIndex) {
    const blocks = buildScoringSamplesFromDailyAggregates(dailyList, nightIndex);
    for (const [type, block] of Object.entries(blocks)) {
      if (samplesByType[type]?.samples?.length > 0) continue;
      samplesByType[type] = block;
    }
    return blocks;
  }

  function mergeFinalDailyAggregates(samplesByType, dailyAggsRaw, sleepDailyRows, hasQueryAggregated) {
    let dailyAggregates = mergeDailyAggregateRows(dailyAggsRaw, buildClientDailyRollups(samplesByType));
    if (sleepDailyRows.length > 0) {
      dailyAggregates = mergeSleepDailyRows(dailyAggregates, sleepDailyRows);
    } else {
      const sleepSamples = samplesByType.sleep?.samples;
      if (sleepSamples?.length) {
        dailyAggregates = mergeSleepIntoDailyAggregates(dailyAggregates, sleepSamples);
      }
    }
    if (!hasQueryAggregated && global.PcpHealthDailyAggregates?.buildFromSamplesByType) {
      dailyAggregates = mergeDailyAggregateRows(
        dailyAggregates,
        global.PcpHealthDailyAggregates.buildFromSamplesByType(samplesByType),
      );
    }
    return filterDailyAggregatesForPost(dailyAggregates);
  }

  /**
   * Sous-ensemble pas / distance / calories (HealthKit statistics) joint à chaque lot
   * streaming — le backend ne doit pas effacer steps_total quand seuls FC/sommeil arrivent.
   */
  function activityOverlayDailyAggregates(dailyList) {
    if (!Array.isArray(dailyList) || dailyList.length === 0) return [];
    return dailyList
      .map((row) => {
        if (!row?.day) return null;
        const overlay = { day: row.day };
        let has = false;
        if (row.steps_total != null) {
          overlay.steps_total = row.steps_total;
          has = true;
        }
        if (row.calories_total_kcal != null) {
          overlay.calories_total_kcal = row.calories_total_kcal;
          has = true;
        }
        if (row.primary_source) overlay.primary_source = row.primary_source;
        return has ? overlay : null;
      })
      .filter(Boolean)
      .filter(isPostableDailyAggregateRow);
  }

  /**
   * POST samples scoring pas/cal/FC repos depuis agrégats HealthKit statistics
   * (+ overlay daily_aggregates pour ne pas effacer les totaux).
   */
  async function postActivityScoringBlocksFromDaily({
    token,
    baseShell,
    dailyAggsRaw,
    nightIndex,
    postQueue: existingQueue,
    logPrefix = "",
  }) {
    const scoringBlocks = buildScoringSamplesFromDailyAggregates(dailyAggsRaw, nightIndex);
    const overlay = activityOverlayDailyAggregates(dailyAggsRaw);
    const postQueue = existingQueue ?? createPostQueue(token);
    let sentSamples = 0;
    let postLots = 0;
    const prefix = logPrefix ? `${logPrefix} ` : "";
    for (const type of ["steps", "calories", "restingHeartRate"]) {
      const block = scoringBlocks[type];
      if (!block?.samples?.length) continue;
      const payload = payloadShell(baseShell, {
        samples_by_type: { [type]: block },
        daily_aggregates: overlay,
        workouts: { items: [] },
      });
      const kb = Math.round(estimateJsonBytes(payload) / 1024);
      log(
        `  POST ${prefix}scoring ${type} (${block.samples.length} jour(s), ~${kb}KB)…`,
      );
      const res = await postQueue.push(`${prefix}${type}`.trim(), payload);
      postLots += 1;
      if (!res.ok) {
        return { ok: false, ...res, token: postQueue.getToken(), sentSamples, postLots };
      }
      sentSamples += block.samples.length;
    }
    return { ok: true, token: postQueue.getToken(), sentSamples, postLots };
  }

  /**
   * Lit HealthKit et POST chaque type dès qu'il est prêt (pipeline).
   * Le testeur voit les 1ères données en ~30s au lieu d'attendre la fin des 60j.
   */
  async function collectAndStreamPost(Health, startDate, endDate, token, options) {
    const manual = !!(options && options.manual);
    const phaseLabel = options?.phase ?? "sync";
    const historicalLight = isHistoricalLightPhase(phaseLabel);
    const incrementalCompact = isIncrementalCompactPhase(phaseLabel);
    const activityAggregatesOnly = isActivityAggregatesOnlyPhase(phaseLabel);
    const vitalCompact = useVitalCompactMode(phaseLabel);
    const sleepCompact = useSleepCompactMode(phaseLabel);
    const strictSlice = options?.strictSlice === true;
    const deferTypePost = historicalLight && strictSlice;
    const windowDays = syncWindowDays(startDate, endDate);
    const syncStartedAt = Date.now();
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const endIsoQuery = new Date(endDate.getTime() + 60 * 1000).toISOString();
    const syncId = crypto.randomUUID();
    const samplesByType = {};
    const readGranted = [];
    const readDenied = [];
    const errors = {};
    let sleepDailyRows = [];
    let totalSamples = 0;
    let workouts = [];
    const hasQueryAggregated = typeof Health.queryAggregated === "function";
    const skipTemperatureInLoop = new Set(["bodyTemperature", "basalBodyTemperature"]);
    /** Pas : statistics seulement. Calories/FC repos : statistics + samples scoring synthétiques. */
    const skipRawSampleTypes = hasQueryAggregated
      ? new Set(["steps", "calories", "restingHeartRate"])
      : new Set();

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);

    const onlyTypes = options?.onlyTypes;
    const rollupScoringRefresh = !!options?.rollupScoringRefresh;
    const sleepOnlyRepair = Array.isArray(onlyTypes) && onlyTypes.length === 1 && onlyTypes[0] === "sleep";
    const vitalsOnlyRepair = Array.isArray(onlyTypes) && onlyTypes.length > 0 && !sleepOnlyRepair;
    const skipHeavyExtras = vitalsOnlyRepair || sleepOnlyRepair;

    const [dailyAggsFetched, pluginVersion] = await Promise.all([
      hasQueryAggregated
        ? fetchDailyAggregatesFromHealthKit(Health, startIso, endIsoQuery, errors, grantedSet)
        : Promise.resolve([]),
      (async () => {
        try {
          const v = await Health.getPluginVersion();
          return v?.version ?? "unknown";
        } catch (_) {
          return "unknown";
        }
      })(),
    ]);
    const dailyAggsRaw = await fillStepsGapsInDailyAggregates(
      Health,
      dailyAggsFetched,
      startIso,
      endIsoQuery,
      grantedSet,
    );
    const activityOverlayAggs = activityOverlayDailyAggregates(dailyAggsRaw);
    if (activityOverlayAggs.length > 0) {
      log(
        `  Overlay activité (pas/cal) : ${activityOverlayAggs.length} jour(s) — joint à chaque lot streaming`,
      );
    }

    const needsVitalNightIndex =
      vitalCompact ||
      isDailyExtendedPhase(phaseLabel) ||
      (Array.isArray(onlyTypes) &&
        onlyTypes.some((t) =>
          [
            "heartRateVariability",
            "respiratoryRate",
            "oxygenSaturation",
            "restingHeartRate",
          ].includes(t),
        ));
    let vitalNightIndex = {};
    if (needsVitalNightIndex && grantedSet.has("sleep")) {
      vitalNightIndex = await loadVitalNightIndex(
        Health,
        startIso,
        endIsoQuery,
        historicalLight,
        sleepCompact || historicalLight,
      );
    }

    const baseShell = buildSyncBasePayload({
      syncId,
      startIso,
      endIso,
      pluginVersion,
      readGranted,
      readDenied,
      errors,
      hasQueryAggregated,
      strategy: hasQueryAggregated
        ? "healthkit_statistics_streaming"
        : "paginated_raw_streaming",
    });
    if (options?.repairStrategy) {
      baseShell.strategy = options.repairStrategy;
    } else if (historicalLight) {
      baseShell.strategy = hasQueryAggregated
        ? "healthkit_historical_light_streaming"
        : "healthkit_historical_light_paginated";
      const sliceNote =
        options?.sliceNum && options?.sliceTotal
          ? ` tranche ${options.sliceNum}/${options.sliceTotal}`
          : "";
      log(
        `[sync-session] HISTORICAL_LIGHT ${windowDays}j${sliceNote} — 1 sample/jour vitaux + sommeil stades compacts${strictSlice ? " (strict)" : ""}`,
      );
    } else if (isDailyExtendedPhase(phaseLabel) || options?.dailyExtendedOnly) {
      baseShell.strategy = "healthkit_daily_extended_streaming";
      const sliceNote =
        options?.sliceNum && options?.sliceTotal
          ? ` tranche ${options.sliceNum}/${options.sliceTotal}`
          : "";
      log(
        `[sync-session] DAILY_EXTENDED ${windowDays}j${sliceNote} — agrégats + sommeil + vitaux + workouts (pas d'intraday)`,
      );
    } else if (incrementalCompact) {
      baseShell.strategy = hasQueryAggregated
        ? "healthkit_incremental_compact_streaming"
        : "healthkit_incremental_compact_paginated";
      log(
        `[sync-session] INCREMENTAL_COMPACT ${windowDays}j — vitaux/sommeil 1 pt/jour, workouts+FC séance bruts`,
      );
    }

    const postQueue = createPostQueue(token);
    const postBodies = [];
    let firstBatchPosted = false;
    let postLots = 0;

    const currentDailyAggs = () =>
      mergeFinalDailyAggregates(samplesByType, dailyAggsRaw, sleepDailyRows, hasQueryAggregated);

    async function postSampleBlock(typeKey, block) {
      const parts = splitTypeBlockIntoChunks(
        { ...baseShell, daily_aggregates: [], samples_by_type: {}, workouts: { items: [] } },
        typeKey,
        block,
        activityOverlayAggs,
      );
      if (parts.length === 0) return { ok: true };

      let lastRes = { ok: true };
      for (let i = 0; i < parts.length; i++) {
        const label = `${typeKey}${parts.length > 1 ? `#${i + 1}` : ""}`;
        const payload = payloadShell(baseShell, {
          samples_by_type: { [typeKey]: parts[i] },
          // Overlay pas/cal HealthKit statistics — évite qu'un lot sommeil/vitaux seul
          // ne recalcule steps_total depuis un vieux sample partiel (ex. 26 pas).
          daily_aggregates: activityOverlayAggs,
          workouts: { items: [] },
        });
        const kb = Math.round(estimateJsonBytes(payload) / 1024);
        const n = parts[i].sample_count ?? parts[i].samples?.length ?? 0;
        log(`  POST streaming lot ${postLots + 1} (${label}, ~${kb}KB, ${n} samples)…`);
        lastRes = await postQueue.push(label, payload);
        postLots += 1;
        if (!lastRes.ok) return lastRes;
        if (lastRes.body) postBodies.push(lastRes.body);
        if (!firstBatchPosted) {
          firstBatchPosted = true;
          const elapsed = Math.round((Date.now() - syncStartedAt) / 1000);
          log(`Premier lot envoyé en ${elapsed}s (${label}) — suite en arrière-plan`);
          log(`[sync-session] PREMIER_POST ${elapsed}s type=${label} ~${kb}KB`);
        }
      }
      return lastRes;
    }

    if (sleepOnlyRepair && Array.isArray(options?.prefetchedSleepSamples)) {
      const prefetched = options.prefetchedSleepSamples;
      if (!prefetched.length) {
        return {
          ok: true,
          skipped: true,
          reason: "no_prefetched_sleep",
          token: postQueue.getToken(),
          sentSamples: 0,
          sentWorkouts: 0,
          sentAggregates: 0,
          batched: true,
          batch_count: 0,
          streaming: true,
        };
      }
      if (!readGranted.includes("sleep")) readGranted.push("sleep");
      const block = {
        data_type: "sleep",
        unit_default: defaultUnit("sleep"),
        sample_count: prefetched.length,
        samples: prefetched,
      };
      log(`  POST sommeil stades ciblé (${prefetched.length} segment(s))…`);
      const sleepPost = await postSampleBlock("sleep", block);
      return {
        ok: sleepPost.ok,
        status: sleepPost.status,
        error: sleepPost.error,
        body: sleepPost.body,
        token: postQueue.getToken(),
        payload: { ...baseShell, sync_id: syncId },
        sentSamples: prefetched.length,
        sentWorkouts: 0,
        sentAggregates: 0,
        batched: true,
        batch_count: postLots,
        streaming: true,
      };
    }

    const dailyExtendedOnly =
      (options?.dailyExtendedOnly === true || isDailyExtendedPhase(phaseLabel)) && !sleepOnlyRepair;

    if (dailyExtendedOnly) {
      if (hasQueryAggregated) {
        const scoringBlocks = buildScoringSamplesFromDailyAggregates(dailyAggsRaw, vitalNightIndex);
        for (const type of ["steps", "calories", "restingHeartRate"]) {
          const block = scoringBlocks[type];
          if (!block?.samples?.length) continue;
          totalSamples += block.samples.length;
          if (!readGranted.includes(type)) readGranted.push(type);
          const scorePost = await postSampleBlock(type, block);
          if (!scorePost.ok) {
            return {
              ok: false,
              status: scorePost.status,
              error: scorePost.error,
              body: scorePost.body,
              token: postQueue.getToken(),
              payload: { ...baseShell, sync_id: syncId },
              sentSamples: totalSamples,
              sentWorkouts: 0,
              sentAggregates: 0,
              batched: true,
              batch_count: postLots,
            };
          }
        }
      }

      let vo2Samples = [];
      try {
        vo2Samples = await fetchAllVo2MaxSamples(
          Health,
          startIso,
          endIsoQuery,
          readGranted,
          readDenied,
          errors,
        );
      } catch (err) {
        errors.vo2Max = String(err?.message ?? err).slice(0, 500);
      }
      if (vo2Samples.length > 0) {
        totalSamples += vo2Samples.length;
        const vo2Post = await postSampleBlock("vo2Max", {
          data_type: "vo2Max",
          unit_default: defaultUnit("vo2Max"),
          sample_count: vo2Samples.length,
          samples: vo2Samples,
        });
        if (!vo2Post.ok) {
          return {
            ok: false,
            status: vo2Post.status,
            error: vo2Post.error,
            body: vo2Post.body,
            token: postQueue.getToken(),
            payload: { ...baseShell, sync_id: syncId },
            sentSamples: totalSamples,
            sentWorkouts: 0,
            sentAggregates: 0,
            batched: true,
            batch_count: postLots,
          };
        }
      }

      try {
        if (grantedSet.has("sleep")) {
          readGranted.push("sleep");
          const sleepRead = await readAllSleepSamples(Health, startIso, endIsoQuery, { light: true });
          const localSleepRows = sleepRead.dailyRows ?? [];
          if (localSleepRows.length > 0) {
            sleepDailyRows = localSleepRows;
            log(`  daily-extended sommeil: ${localSleepRows.length} nuit(s) agrégées`);
            const sleepSamples = buildSleepCompactSamplesFromRaw(sleepRead.raw ?? [], localSleepRows, {
              historicalLight: false,
            });
            if (sleepSamples.length > 0) {
              totalSamples += sleepSamples.length;
              const sleepPost = await postSampleBlock("sleep", {
                data_type: "sleep",
                unit_default: defaultUnit("sleep"),
                sample_count: sleepSamples.length,
                samples: sleepSamples,
              });
              if (!sleepPost.ok) {
                return {
                  ok: false,
                  status: sleepPost.status,
                  error: sleepPost.error,
                  body: sleepPost.body,
                  token: postQueue.getToken(),
                  payload: { ...baseShell, sync_id: syncId },
                  sentSamples: totalSamples,
                  sentWorkouts: 0,
                  sentAggregates: 0,
                  batched: true,
                  batch_count: postLots,
                };
              }
            }
          }
        }
      } catch (err) {
        errors.sleep = String(err?.message ?? err).slice(0, 500);
      }

      try {
        const vitalBlocks = await readDailyExtendedVitalsCompact(
          Health,
          startIso,
          endIsoQuery,
          grantedSet,
          readGranted,
          errors,
          vitalNightIndex,
        );
        for (const [type, samples] of Object.entries(vitalBlocks)) {
          totalSamples += samples.length;
          const block = {
            data_type: type,
            unit_default: defaultUnit(type),
            sample_count: samples.length,
            samples,
          };
          samplesByType[type] = block;
          const vitalPost = await postSampleBlock(type, block);
          if (!vitalPost.ok) {
            return {
              ok: false,
              status: vitalPost.status,
              error: vitalPost.error,
              body: vitalPost.body,
              token: postQueue.getToken(),
              payload: { ...baseShell, sync_id: syncId },
              sentSamples: totalSamples,
              sentWorkouts: 0,
              sentAggregates: 0,
              batched: true,
              batch_count: postLots,
            };
          }
        }
      } catch (err) {
        errors.daily_extended_vitals = String(err?.message ?? err).slice(0, 500);
      }

      try {
        const canCapgoWorkouts = typeof Health.queryWorkouts === "function" && grantedSet.has("workouts");
        const canNativeWorkouts = !!window.webkit?.messageHandlers?.pcpHealthReadWorkouts;
        if (canCapgoWorkouts || canNativeWorkouts) {
          if (grantedSet.has("workouts")) readGranted.push("workouts");
          workouts = await fetchAllWorkouts(Health, startIso, endIsoQuery);
          if (workouts.length > 0 && !readGranted.includes("workouts")) readGranted.push("workouts");
        }
      } catch (err) {
        errors.workouts = String(err?.message ?? err).slice(0, 500);
      }

      const dailyAggregates = currentDailyAggs();
      logDailyParitySummary(dailyAggregates);

      if (workouts.length > 0) {
        const wPayload = payloadShell(baseShell, {
          samples_by_type: {},
          daily_aggregates: dailyAggregates,
          workouts: { items: workouts },
        });
        log(`  POST daily-extended workouts (${workouts.length})…`);
        const wRes = await postQueue.push("workouts", wPayload);
        postLots += 1;
        if (!wRes.ok) {
          return {
            ok: false,
            status: wRes.status,
            error: wRes.error,
            body: wRes.body,
            token: postQueue.getToken(),
            payload: { ...baseShell, sync_id: syncId },
            sentSamples: totalSamples,
            sentWorkouts: workouts.length,
            sentAggregates: dailyAggregates.length,
            batched: true,
            batch_count: postLots,
          };
        }
      }

      if (dailyAggregates.length > 0) {
        const aPayload = payloadShell(baseShell, {
          samples_by_type: {},
          daily_aggregates: dailyAggregates,
          workouts: { items: [] },
        });
        log(`  POST daily-extended daily_aggregates (${dailyAggregates.length} j)…`);
        const aRes = await postQueue.push("daily_aggregates", aPayload);
        postLots += 1;
        if (!aRes.ok) {
          return {
            ok: false,
            status: aRes.status,
            error: aRes.error,
            body: aRes.body,
            token: postQueue.getToken(),
            payload: { ...baseShell, sync_id: syncId },
            sentSamples: totalSamples,
            sentWorkouts: workouts.length,
            sentAggregates: dailyAggregates.length,
            batched: true,
            batch_count: postLots,
          };
        }
      }

      return {
        ok: true,
        status: 200,
        token: postQueue.getToken(),
        body: postBodies[postBodies.length - 1],
        payload: { ...baseShell, sync_id: syncId },
        sentSamples: totalSamples,
        sentWorkouts: workouts.length,
        sentAggregates: dailyAggregates.length,
        batched: true,
        batch_count: postLots,
        streaming: true,
      };
    }

    if (hasQueryAggregated && (!onlyTypes || rollupScoringRefresh)) {
      const scoringBlocks = buildScoringSamplesFromDailyAggregates(dailyAggsRaw, vitalNightIndex);
      const scoringOrder = ["steps", "calories", "restingHeartRate"];
      for (const type of scoringOrder) {
        const block = scoringBlocks[type];
        if (!block?.samples?.length) continue;
        samplesByType[type] = block;
        totalSamples += block.samples.length;
        if (!readGranted.includes(type)) readGranted.push(type);
        log(`  POST scoring ${type} (${block.samples.length} jour(s) depuis statistics)…`);
        const scorePost = await postSampleBlock(type, block);
        if (!scorePost.ok) {
          return {
            ok: false,
            status: scorePost.status,
            error: scorePost.error,
            body: scorePost.body,
            token: postQueue.getToken(),
            payload: { ...baseShell, sync_id: syncId },
            sentSamples: totalSamples,
            sentWorkouts: 0,
            sentAggregates: 0,
            batched: true,
            batch_count: postLots,
          };
        }
      }
      if (activityAggregatesOnly) {
        log(
          "  Pas/cal/FC repos : daily_aggregates + samples |agg| scoring (upsert backend)",
        );
      }
    }

    const typesToRead = SAMPLE_TYPES.filter(
      (type) =>
        (!onlyTypes || onlyTypes.includes(type)) &&
        !skipRawSampleTypes.has(type) &&
        !skipTemperatureInLoop.has(type),
    );

    log(
      historicalLight
        ? `Pipeline sync (${windowDays}j, ${phaseLabel}) : mode historique léger — lecture ∥${READ_CONCURRENCY}, POST compact…`
        : incrementalCompact
          ? `Pipeline sync (${windowDays}j, ${phaseLabel}) : mode incrémental compact — vitaux/sommeil 1 pt/jour…`
          : `Pipeline sync (${windowDays}j, ${phaseLabel}) : lecture ∥${READ_CONCURRENCY} + POST par type/tranche ${DATE_CHUNK_DAYS}j…`,
    );

    let streamPostError = null;

    const typeResults = await runWithConcurrency(typesToRead, READ_CONCURRENCY, async (type) => {
      if (streamPostError) return { type, skipped: true };
      if (!grantedSet.has(type)) {
        return { type, denied: true };
      }
      try {
        let samples;
        let localSleepRows = [];
        let typeTruncated = false;
        const streamDenseChunks = DATE_CHUNK_READ_TYPES.has(type) && !vitalCompact;

        if (type === "sleep") {
          const sleepRead = await readAllSleepSamples(Health, startIso, endIsoQuery, {
            light: sleepCompact,
          });
          typeTruncated = !!sleepRead.truncated;
          localSleepRows = sleepRead.dailyRows;
          if (sleepCompact) {
            const compactLabel = historicalLight ? "léger" : "compact";
            samples = buildSleepCompactSamplesFromRaw(sleepRead.raw ?? [], localSleepRows, {
              historicalLight,
            });
            const nights = clusterSleepRawIntoNights(sleepRead.raw ?? []).length;
            log(
              `  sleep (${compactLabel}): ${sleepRead.raw?.length ?? 0} bruts → ${samples.length} sample(s) (${describeSleepCompactPostMode(samples)}${nights ? `, ${nights} nuit(s) HK` : ""})`,
            );
            if (samples.length === 0 && sleepRead.raw?.length > 0) {
              log(`  sleep ${compactLabel}: repli segments bruts (${sleepRead.raw.length} HK)`);
              for (const r of sleepRead.raw) {
                samples.push(...normalizeSleepSamples(r));
              }
            }
          } else {
            samples = sleepRead.normalized;
          }
        } else if (vitalCompact && DATE_CHUNK_READ_TYPES.has(type)) {
          const chunkRead = await readAllSamplesByDateChunks(Health, type, startIso, endIsoQuery);
          const rawSamples = chunkRead.samples ?? [];
          typeTruncated = !!chunkRead.truncated;
          samples = collapseVitalSamplesToDailySynthetic(rawSamples, type, vitalNightIndex);
          const compactLabel = historicalLight ? "léger" : "compact";
          log(`  ${type} ${compactLabel}: ${rawSamples.length} bruts → ${samples.length} jour(s)`);
          if (samples.length === 0 && rawSamples.length > 0) {
            log(`  ${type} ${compactLabel}: repli samples bruts (${rawSamples.length})`);
            samples = filterNightVitalSamplesForPost(rawSamples, type);
          }
        } else if (streamDenseChunks) {
          const streamRes = await readAndStreamSamplesByDateChunks(
            Health,
            type,
            startIso,
            endIsoQuery,
            async (chunkBlock, chunkIdx, chunkTotal) => {
              accumulateSampleBlock(samplesByType, type, chunkBlock);
              totalSamples += chunkBlock.samples.length;
              log(`  ${type} tranche ${chunkIdx}/${chunkTotal} → POST (${chunkBlock.samples.length} samples)`);
              return postSampleBlock(type, chunkBlock);
            },
          );
          if (!streamRes.ok) {
            streamPostError = streamRes.postRes;
            return { type, granted: true, postFailed: true };
          }
          samples = streamRes.samples;
        } else {
          const meta = await readAllSamplesWithMeta(Health, type, startIso, endIsoQuery);
          samples = meta.samples;
          typeTruncated = !!meta.truncated;
        }

        if (localSleepRows.length) sleepDailyRows = localSleepRows;

        if (!streamDenseChunks && !deferTypePost) {
          totalSamples += samples.length;
          if (samples.length > 0) {
            const block = {
              data_type: type,
              unit_default: defaultUnit(type),
              sample_count: samples.length,
              samples,
            };
            samplesByType[type] = block;
            const postRes = await postSampleBlock(type, block);
            if (!postRes.ok) {
              streamPostError = postRes;
              return { type, granted: true, postFailed: true };
            }
          }
        }

        return {
          type,
          granted: true,
          samples,
          sleepDailyRows: localSleepRows,
          truncated: typeTruncated,
          streamDenseChunks,
        };
      } catch (err) {
        return { type, granted: true, error: String(err?.message ?? err).slice(0, 500) };
      }
    });

    if (streamPostError) {
      return {
        ok: false,
        status: streamPostError.status,
        error: streamPostError.error,
        body: streamPostError.body,
        token: postQueue.getToken(),
        payload: { ...baseShell, sync_id: syncId },
        sentSamples: totalSamples,
        sentWorkouts: 0,
        sentAggregates: currentDailyAggs().length,
        batched: true,
        batch_count: postLots,
      };
    }

    const readTruncated = [];
    for (const result of typeResults) {
      if (result?.truncated) readTruncated.push(result.type);
    }

    if (deferTypePost && strictSlice && readTruncated.length > 0) {
      log(
        `Tranche historique refusée — lecture HealthKit tronquée (${readTruncated.join(", ")}) ; reprise au prochain essai`,
      );
      log(`[sync-session] HISTORICAL_SLICE_TRUNCATED types=${readTruncated.join(",")}`);
      return {
        ok: false,
        status: 422,
        error: `truncated_read:${readTruncated.join(",")}`,
        readTruncated,
        token: postQueue.getToken(),
        payload: { ...baseShell, sync_id: syncId },
        sentSamples: totalSamples,
        sentWorkouts: 0,
        sentAggregates: currentDailyAggs().length,
        batched: true,
        batch_count: postLots,
      };
    }

    if (deferTypePost) {
      for (const result of typeResults) {
        if (result.denied || result.skipped || result.postFailed || result.streamDenseChunks) continue;
        const samples = result.samples ?? [];
        if (result.sleepDailyRows?.length) sleepDailyRows = result.sleepDailyRows;
        totalSamples += samples.length;
        if (samples.length > 0) {
          const block = {
            data_type: result.type,
            unit_default: defaultUnit(result.type),
            sample_count: samples.length,
            samples,
          };
          samplesByType[result.type] = block;
          const postRes = await postSampleBlock(result.type, block);
          if (!postRes.ok) {
            return {
              ok: false,
              status: postRes.status,
              error: postRes.error,
              body: postRes.body,
              token: postQueue.getToken(),
              payload: { ...baseShell, sync_id: syncId },
              sentSamples: totalSamples,
              sentWorkouts: 0,
              sentAggregates: currentDailyAggs().length,
              batched: true,
              batch_count: postLots,
            };
          }
        }
      }
    }

    for (const result of typeResults) {
      if (result.denied) {
        readDenied.push(result.type);
        continue;
      }
      if (result.skipped) continue;
      readGranted.push(result.type);
      if (result.error) {
        errors[result.type] = result.error;
        log(`readSamples(${result.type}) erreur: ${result.error}`);
      }
    }

    if (skipHeavyExtras) {
      if (vitalsOnlyRepair && options?.injectedSleepSamples?.length) {
        const companions = options.injectedSleepSamples;
        totalSamples += companions.length;
        const block = {
          data_type: "sleep",
          unit_default: defaultUnit("sleep"),
          sample_count: companions.length,
          samples: companions,
        };
        samplesByType.sleep = block;
        if (!readGranted.includes("sleep")) readGranted.push("sleep");
        log(`  POST recovery companion sleep (${companions.length} segment(s))…`);
        const sleepPost = await postSampleBlock("sleep", block);
        if (!sleepPost.ok) {
          return {
            ok: false,
            status: sleepPost.status,
            error: sleepPost.error,
            body: sleepPost.body,
            token: postQueue.getToken(),
            payload: { ...baseShell, sync_id: syncId },
            sentSamples: totalSamples,
            sentWorkouts: 0,
            sentAggregates: 0,
            batched: true,
            batch_count: postLots,
          };
        }
      }
      return {
        ok: true,
        status: 200,
        token: postQueue.getToken(),
        body: postBodies[postBodies.length - 1],
        payload: { ...baseShell, sync_id: syncId },
        sentSamples: totalSamples,
        sentWorkouts: 0,
        sentAggregates: 0,
        batched: true,
        batch_count: postLots,
        streaming: true,
      };
    }

    const [tempSamples, vo2Samples, workoutsResult] = await Promise.all([
      fetchAllTemperatureSamples(Health, startIso, endIsoQuery, readGranted, readDenied, errors).catch(
        (err) => {
          errors.bodyTemperature = String(err?.message ?? err).slice(0, 500);
          return [];
        },
      ),
      fetchAllVo2MaxSamples(Health, startIso, endIsoQuery, readGranted, readDenied, errors).catch(
        (err) => {
          errors.vo2Max = String(err?.message ?? err).slice(0, 500);
          return [];
        },
      ),
      (async () => {
        if (typeof Health.queryWorkouts !== "function") return [];
        try {
          if (!grantedSet.has("workouts")) {
            readDenied.push("workouts");
            return [];
          }
          readGranted.push("workouts");
          return await fetchAllWorkouts(Health, startIso, endIsoQuery);
        } catch (err) {
          errors.workouts = String(err?.message ?? err).slice(0, 500);
          return [];
        }
      })(),
    ]);

    if (tempSamples.length > 0) {
      let tempToPost = tempSamples;
      if (historicalLight && tempSamples.length > 50) {
        const collapsed = collapseVitalSamplesToDailySynthetic(tempSamples, "bodyTemperature", vitalNightIndex);
        if (collapsed.length > 0) {
          log(`  bodyTemperature léger: ${tempSamples.length} bruts → ${collapsed.length} jour(s)`);
          tempToPost = collapsed;
        }
      }
      totalSamples += tempToPost.length;
      const block = {
        data_type: "bodyTemperature",
        unit_default: defaultUnit("bodyTemperature"),
        sample_count: tempToPost.length,
        samples: tempToPost,
      };
      samplesByType.bodyTemperature = block;
      const postRes = await postSampleBlock("bodyTemperature", block);
      if (!postRes.ok) {
        return {
          ok: false,
          status: postRes.status,
          error: postRes.error,
          body: postRes.body,
          token: postQueue.getToken(),
          payload: { ...baseShell, sync_id: syncId },
          sentSamples: totalSamples,
          sentWorkouts: 0,
          sentAggregates: currentDailyAggs().length,
          batched: true,
          batch_count: postLots,
        };
      }
    }

    if (vo2Samples.length > 0) {
      totalSamples += vo2Samples.length;
      const vo2Block = {
        data_type: "vo2Max",
        unit_default: defaultUnit("vo2Max"),
        sample_count: vo2Samples.length,
        samples: vo2Samples,
      };
      samplesByType.vo2Max = vo2Block;
      const vo2PostRes = await postSampleBlock("vo2Max", vo2Block);
      if (!vo2PostRes.ok) {
        return {
          ok: false,
          status: vo2PostRes.status,
          error: vo2PostRes.error,
          body: vo2PostRes.body,
          token: postQueue.getToken(),
          payload: { ...baseShell, sync_id: syncId },
          sentSamples: totalSamples,
          sentWorkouts: 0,
          sentAggregates: currentDailyAggs().length,
          batched: true,
          batch_count: postLots,
        };
      }
    }

    workouts = workoutsResult;

    const hrWorkoutSamples = await fetchHeartRateSamplesForWorkouts(
      Health,
      workouts,
      grantedSet,
      errors,
    );
    if (hrWorkoutSamples.length > 0) {
      readGranted.push("heartRate");
      totalSamples += hrWorkoutSamples.length;
      const hrBlock = {
        data_type: "heartRate",
        unit_default: defaultUnit("heartRate"),
        sample_count: hrWorkoutSamples.length,
        samples: hrWorkoutSamples,
      };
      samplesByType.heartRate = hrBlock;
      const hrPostRes = await postSampleBlock("heartRate", hrBlock);
      if (!hrPostRes.ok) {
        return {
          ok: false,
          status: hrPostRes.status,
          error: hrPostRes.error,
          body: hrPostRes.body,
          token: postQueue.getToken(),
          payload: { ...baseShell, sync_id: syncId },
          sentSamples: totalSamples,
          sentWorkouts: workouts.length,
          sentAggregates: currentDailyAggs().length,
          batched: true,
          batch_count: postLots,
        };
      }
    }

    const dailyAggregates = currentDailyAggs();
    logDailyParitySummary(dailyAggregates);

    if (workouts.length > 0) {
      const payload = payloadShell(baseShell, {
        samples_by_type: {},
        daily_aggregates: dailyAggregates,
        workouts: { items: workouts },
      });
      log(`  POST streaming workouts (${workouts.length})…`);
      const wRes = await postQueue.push("workouts", payload);
      postLots += 1;
      if (!wRes.ok) {
        return {
          ok: false,
          status: wRes.status,
          error: wRes.error,
          body: wRes.body,
          token: postQueue.getToken(),
          payload: { ...baseShell, sync_id: syncId },
          sentSamples: totalSamples,
          sentWorkouts: workouts.length,
          sentAggregates: dailyAggregates.length,
          batched: true,
          batch_count: postLots,
        };
      }
      if (wRes.body) postBodies.push(wRes.body);
    } else if (dailyAggregates.length > 0 && (!onlyTypes || rollupScoringRefresh)) {
      const payload = payloadShell(baseShell, {
        samples_by_type: {},
        daily_aggregates: dailyAggregates,
        workouts: { items: [] },
      });
      log(`  POST streaming daily_aggregates (${dailyAggregates.length} j)…`);
      const aRes = await postQueue.push("daily_aggregates", payload);
      postLots += 1;
      if (!aRes.ok) {
        return {
          ok: false,
          status: aRes.status,
          error: aRes.error,
          body: aRes.body,
          token: postQueue.getToken(),
          payload: { ...baseShell, sync_id: syncId },
          sentSamples: totalSamples,
          sentWorkouts: 0,
          sentAggregates: dailyAggregates.length,
          batched: true,
          batch_count: postLots,
        };
      }
      if (aRes.body) postBodies.push(aRes.body);
    }

    const payload = {
      ...baseShell,
      samples_by_type: samplesByType,
      workouts: { items: workouts },
      daily_aggregates: dailyAggregates,
    };

    log(
      `Pipeline terminé en ${Math.round((Date.now() - syncStartedAt) / 1000)}s — ${postLots} lot(s), ${totalSamples} samples`,
    );

    return {
      ok: true,
      payload,
      sentSamples: totalSamples,
      sentWorkouts: workouts.length,
      sentAggregates: dailyAggregates.length,
      body: mergeBatchBodies(postBodies),
      token: postQueue.getToken(),
      batched: postLots > 1,
      batch_count: postLots,
      streaming: true,
      readTruncated,
    };
  }

  async function buildPayload(Health, startDate, endDate) {
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const samplesByType = {};
    const readGranted = [];
    const readDenied = [];
    const errors = {};
    let totalSamples = 0;
    let workouts = [];
    let sleepDailyRows = [];
    const hasQueryAggregated = typeof Health.queryAggregated === "function";
    /** Types lus via fetchAllTemperatureSamples (Watch = poignet natif). */
    const skipTemperatureInLoop = new Set(["bodyTemperature", "basalBodyTemperature"]);
    /** Pas / calories / FC repos : totaux via statistics ; samples bruts = doublons. */
    const skipRawSampleTypes = hasQueryAggregated
      ? new Set(["steps", "calories", "restingHeartRate"])
      : new Set();
    /** endDate Capgo = exclusif — marge pour inclure workouts / samples du jour. */
    const endIsoQuery = new Date(endDate.getTime() + 60 * 1000).toISOString();

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);

    const typesToRead = SAMPLE_TYPES.filter(
      (type) => !skipRawSampleTypes.has(type) && !skipTemperatureInLoop.has(type),
    );

    const readStartedAt = Date.now();
    log(`Lecture HealthKit parallèle (${typesToRead.length} types, concurrence ${READ_CONCURRENCY})…`);

    const typeResults = await runWithConcurrency(typesToRead, READ_CONCURRENCY, async (type) => {
      if (!grantedSet.has(type)) {
        return { type, denied: true };
      }
      try {
        if (type === "sleep") {
          const sleepRead = await readAllSleepSamples(Health, startIso, endIsoQuery);
          return {
            type,
            granted: true,
            samples: sleepRead.normalized,
            sleepDailyRows: sleepRead.dailyRows,
          };
        }
        const samples = await readAllSamples(Health, type, startIso, endIsoQuery);
        return { type, granted: true, samples };
      } catch (err) {
        return { type, granted: true, error: String(err?.message ?? err).slice(0, 500) };
      }
    });

    for (const result of typeResults) {
      if (result.denied) {
        readDenied.push(result.type);
        continue;
      }
      readGranted.push(result.type);
      if (result.error) {
        errors[result.type] = result.error;
        log(`readSamples(${result.type}) erreur: ${result.error}`);
        continue;
      }
      const samples = result.samples ?? [];
      if (result.sleepDailyRows?.length) {
        sleepDailyRows = result.sleepDailyRows;
      }
      totalSamples += samples.length;
      if (samples.length > 0) {
        samplesByType[result.type] = {
          data_type: result.type,
          unit_default: defaultUnit(result.type),
          sample_count: samples.length,
          samples,
        };
      }
    }
    log(`Lecture types terminée en ${Math.round((Date.now() - readStartedAt) / 1000)}s`);

    const [tempSamples, vo2Samples, workoutsResult, dailyAggsRaw, pluginVersion] = await Promise.all([
        fetchAllTemperatureSamples(Health, startIso, endIsoQuery, readGranted, readDenied, errors).catch(
          (err) => {
            errors.bodyTemperature = String(err?.message ?? err).slice(0, 500);
            log(`fetchAllTemperatureSamples erreur: ${err}`);
            return [];
          },
        ),
        fetchAllVo2MaxSamples(Health, startIso, endIsoQuery, readGranted, readDenied, errors).catch(
          (err) => {
            errors.vo2Max = String(err?.message ?? err).slice(0, 500);
            log(`fetchAllVo2MaxSamples erreur: ${err}`);
            return [];
          },
        ),
        (async () => {
          if (typeof Health.queryWorkouts !== "function") return [];
          try {
            if (!grantedSet.has("workouts")) {
              readDenied.push("workouts");
              return [];
            }
            readGranted.push("workouts");
            return await fetchAllWorkouts(Health, startIso, endIsoQuery);
          } catch (err) {
            errors.workouts = String(err?.message ?? err).slice(0, 500);
            log(`queryWorkouts erreur: ${err}`);
            return [];
          }
        })(),
        fetchDailyAggregatesFromHealthKit(Health, startIso, endIsoQuery, errors, grantedSet),
        (async () => {
          try {
            const v = await Health.getPluginVersion();
            return v?.version ?? "unknown";
          } catch (_) {
            return "unknown";
          }
        })(),
      ]);

    const dailyAggsFilled = await fillStepsGapsInDailyAggregates(
      Health,
      dailyAggsRaw,
      startIso,
      endIsoQuery,
      grantedSet,
    );
    if (hasQueryAggregated) {
      const scoringBlocks = mergeScoringSamplesFromDailyAggregates(samplesByType, dailyAggsFilled, vitalNightIndex);
      for (const block of Object.values(scoringBlocks)) {
        totalSamples += block.samples?.length ?? 0;
      }
    }

    totalSamples += tempSamples.length;
    if (tempSamples.length > 0) {
      samplesByType.bodyTemperature = {
        data_type: "bodyTemperature",
        unit_default: defaultUnit("bodyTemperature"),
        sample_count: tempSamples.length,
        samples: tempSamples,
      };
    }

    totalSamples += vo2Samples.length;
    if (vo2Samples.length > 0) {
      samplesByType.vo2Max = {
        data_type: "vo2Max",
        unit_default: defaultUnit("vo2Max"),
        sample_count: vo2Samples.length,
        samples: vo2Samples,
      };
    }

    workouts = workoutsResult;
    const hrWorkoutSamples = await fetchHeartRateSamplesForWorkouts(
      Health,
      workouts,
      grantedSet,
      errors,
    );
    if (hrWorkoutSamples.length > 0) {
      readGranted.push("heartRate");
      totalSamples += hrWorkoutSamples.length;
      samplesByType.heartRate = {
        data_type: "heartRate",
        unit_default: defaultUnit("heartRate"),
        sample_count: hrWorkoutSamples.length,
        samples: hrWorkoutSamples,
      };
    }

    let dailyAggregates = mergeDailyAggregateRows(
      dailyAggsFilled,
      buildClientDailyRollups(samplesByType),
    );
    if (sleepDailyRows.length > 0) {
      dailyAggregates = mergeSleepDailyRows(dailyAggregates, sleepDailyRows);
    } else {
      const sleepSamples = samplesByType.sleep?.samples;
      if (sleepSamples?.length) {
        dailyAggregates = mergeSleepIntoDailyAggregates(dailyAggregates, sleepSamples);
      }
    }
    logDailyParitySummary(dailyAggregates);
    if (!hasQueryAggregated && global.PcpHealthDailyAggregates?.buildFromSamplesByType) {
      dailyAggregates = mergeDailyAggregateRows(
        dailyAggregates,
        global.PcpHealthDailyAggregates.buildFromSamplesByType(samplesByType),
      );
    }
    if (hasQueryAggregated) {
      mergeScoringSamplesFromDailyAggregates(samplesByType, dailyAggregates, vitalNightIndex);
    }

    return {
      payload: {
        schema_version: 1,
        sync_id: crypto.randomUUID(),
        synced_at: new Date().toISOString(),
        client: {
          app: "com.pcpinnov.pcpttherapy",
          app_version: "1.0.0",
          platform: "ios",
          plugin: "@capgo/capacitor-health",
          plugin_version: pluginVersion,
          // Backend VARCHAR(50) — ne pas envoyer tout le userAgent.
          os_version: clientOsVersion(),
        },
        source: "healthkit",
        window: { start_date: startIso, end_date: endIso },
        authorization: { read_granted: dedupe(readGranted), read_denied: dedupe(readDenied) },
        fetch: {
          strategy: hasQueryAggregated
            ? "healthkit_statistics_paginated_raw"
            : "paginated_raw",
          limits: {
            per_type_page_size: SAMPLE_PAGE_SIZE,
            per_type_page_size_high: SAMPLE_PAGE_SIZE_HIGH,
            max_sample_pages: MAX_SAMPLE_PAGES,
            workout_page_size: WORKOUT_PAGE_SIZE,
            date_chunk_days: DATE_CHUNK_DAYS,
            date_chunk_types: [...DATE_CHUNK_READ_TYPES],
            dense_stream_post_bytes: MAX_DENSE_STREAM_POST_BYTES,
            dense_stream_max_samples: MAX_DENSE_STREAM_SAMPLES,
            dense_stream_types: [...DENSE_STREAM_POST_TYPES],
          },
          partial: Object.keys(errors).length > 0,
          errors,
        },
        samples_by_type: samplesByType,
        workouts: { items: workouts },
        daily_aggregates: dailyAggregates,
      },
      sentSamples: totalSamples,
      sentWorkouts: workouts.length,
      sentAggregates: dailyAggregates.length,
    };
  }

  function emitSyncEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail ?? {} }));
    } catch (_) {}
  }

  /** Token frais + retry une fois sur 401 (session NextAuth expirée en WebView). */
  async function resolveSyncAccessToken(token) {
    const bridge = window.PcpHealthBridge;
    if (bridge?.ensureAccessToken) {
      try {
        const fresh = await bridge.ensureAccessToken();
        if (fresh) return fresh;
      } catch (_) {}
    }
    return token;
  }

  function estimateJsonBytes(obj) {
    try {
      return JSON.stringify(obj).length;
    } catch (_) {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  function payloadShell(basePayload, overrides) {
    return {
      schema_version: basePayload.schema_version,
      sync_id: overrides.sync_id ?? crypto.randomUUID(),
      synced_at: basePayload.synced_at,
      client: basePayload.client,
      source: basePayload.source,
      window: basePayload.window,
      authorization: basePayload.authorization,
      fetch: basePayload.fetch,
      samples_by_type: overrides.samples_by_type ?? {},
      workouts: overrides.workouts ?? { items: [] },
      daily_aggregates: overrides.daily_aggregates ?? [],
    };
  }

  function estimateChunkPostBytes(basePayload, typeKey, block, overlayAggs) {
    return estimateJsonBytes(
      payloadShell(basePayload, {
        samples_by_type: { [typeKey]: block },
        daily_aggregates: overlayAggs ?? basePayload.daily_aggregates ?? [],
      }),
    );
  }

  function typeChunkLimits(typeKey) {
    if (DENSE_STREAM_POST_TYPES.has(typeKey)) {
      return { maxBytes: MAX_DENSE_STREAM_POST_BYTES, maxSamples: MAX_DENSE_STREAM_SAMPLES };
    }
    return { maxBytes: MAX_SYNC_POST_BYTES, maxSamples: Number.POSITIVE_INFINITY };
  }

  function chunkBlockExceedsLimits(basePayload, typeKey, batch, block, limits, overlayAggs) {
    if (batch.length > limits.maxSamples) return true;
    const probe = { ...block, samples: batch, sample_count: batch.length };
    return estimateChunkPostBytes(basePayload, typeKey, probe, overlayAggs) > limits.maxBytes;
  }

  /** Répartit un bloc trop gros (sommeil, FC/HRV denses) sous les limites octets + samples. */
  function appendSplitChunks(basePayload, typeKey, block, batch, limits, chunks, overlayAggs) {
    if (batch.length === 0) return;
    if (!chunkBlockExceedsLimits(basePayload, typeKey, batch, block, limits, overlayAggs)) {
      chunks.push({ ...block, samples: batch, sample_count: batch.length });
      return;
    }
    if (batch.length > limits.maxSamples) {
      for (let i = 0; i < batch.length; i += limits.maxSamples) {
        appendSplitChunks(
          basePayload,
          typeKey,
          block,
          batch.slice(i, i + limits.maxSamples),
          limits,
          chunks,
          overlayAggs,
        );
      }
      return;
    }
    const half = Math.ceil(batch.length / 2);
    appendSplitChunks(basePayload, typeKey, block, batch.slice(0, half), limits, chunks, overlayAggs);
    appendSplitChunks(basePayload, typeKey, block, batch.slice(half), limits, chunks, overlayAggs);
  }

  function splitTypeBlockIntoChunks(basePayload, typeKey, block, overlayAggs) {
    const samples = Array.isArray(block?.samples) ? block.samples : [];
    if (samples.length === 0) return [];

    const limits = typeChunkLimits(typeKey);
    const chunks = [];
    let batch = [];
    for (const sample of samples) {
      batch.push(sample);
      if (
        chunkBlockExceedsLimits(basePayload, typeKey, batch, block, limits, overlayAggs) &&
        batch.length > 1
      ) {
        const tail = batch.pop();
        chunks.push({ ...block, samples: batch, sample_count: batch.length });
        batch = [tail];
      }
    }
    if (batch.length > 0) {
      appendSplitChunks(basePayload, typeKey, block, batch, limits, chunks, overlayAggs);
    }
    return chunks;
  }

  function mergeBatchBodies(bodies) {
    const merged = {
      samples_received: 0,
      samples_inserted: 0,
      samples_skipped: 0,
      workouts_received: 0,
      workouts_inserted: 0,
      workouts_skipped: 0,
      aggregates_received: 0,
      aggregates_inserted: 0,
    };
    for (const b of bodies) {
      if (!b || typeof b !== "object") continue;
      merged.samples_received += Number(b.samples_received) || 0;
      merged.samples_inserted += Number(b.samples_inserted) || 0;
      merged.samples_skipped += Number(b.samples_skipped) || 0;
      merged.workouts_received += Number(b.workouts_received) || 0;
      merged.workouts_inserted += Number(b.workouts_inserted) || 0;
      merged.workouts_skipped += Number(b.workouts_skipped) || 0;
      merged.aggregates_received += Number(b.aggregates_received) || 0;
      merged.aggregates_inserted += Number(b.aggregates_inserted) || 0;
    }
    return merged;
  }

  async function postHealthSyncWithRetry(token, payload, label, options) {
    const quiet = !!(options && options.quiet);
    let authToken = options?.authToken;
    let last = null;
    for (let attempt = 1; attempt <= SYNC_POST_MAX_RETRIES; attempt++) {
      last = await postHealthSync(token, payload, {
        quiet: quiet || attempt > 1,
        authToken,
      });
      if (last.token) authToken = last.token;
      if (last.ok) return { ...last, token: authToken ?? last.token };
      const errText = String(last.error ?? "");
      const retryable =
        last.status === 0 || /load failed|network|timed out|aborted/i.test(errText);
      if (!retryable || attempt >= SYNC_POST_MAX_RETRIES) return last;
      if (!quiet) {
        log(
          `POST sync échec (${label}) — retry ${attempt + 1}/${SYNC_POST_MAX_RETRIES} dans ${SYNC_POST_RETRY_MS * attempt}ms…`,
        );
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, SYNC_POST_RETRY_MS * attempt);
      });
    }
    return last;
  }

  /**
   * Regroupe plusieurs types dans un même POST jusqu'à MAX_SYNC_POST_BYTES.
   * daily_aggregates répétés à chaque lot (overlay pas/calories Santé côté backend).
   */
  function buildBatchedPostPlans(basePayload) {
    const dailyAggs = basePayload.daily_aggregates ?? [];
    const workouts = basePayload.workouts ?? { items: [] };
    const hasWorkouts = workouts.items?.length > 0;
    const samplesByType = basePayload.samples_by_type ?? {};

    const items = [];
    for (const typeKey of Object.keys(samplesByType)) {
      const block = samplesByType[typeKey];
      const parts = splitTypeBlockIntoChunks(basePayload, typeKey, block);
      for (let i = 0; i < parts.length; i++) {
        items.push({
          typeKey,
          partIndex: i,
          partCount: parts.length,
          block: parts[i],
        });
      }
    }

    const estimateBatch = (samples, withWorkouts) =>
      estimateJsonBytes(
        payloadShell(basePayload, {
          samples_by_type: samples,
          daily_aggregates: dailyAggs,
          workouts: withWorkouts ? workouts : { items: [] },
        }),
      );

    const plans = [];
    let batchSamples = {};
    let includeWorkoutsInNext = hasWorkouts;

    const flushBatch = () => {
      const withWorkouts = includeWorkoutsInNext;
      const keys = Object.keys(batchSamples);
      if (keys.length === 0 && !withWorkouts && dailyAggs.length === 0) return;

      const labelParts = keys.map((k) => {
        const item = items.find((it) => it.typeKey === k && it.block === batchSamples[k]);
        if (item && item.partCount > 1) return `${k}#${item.partIndex + 1}`;
        return k;
      });
      if (withWorkouts) labelParts.push("workouts");
      if (keys.length === 0 && labelParts.length === 0) labelParts.push("agrégats");

      plans.push({
        label: labelParts.join("+"),
        payload: payloadShell(basePayload, {
          samples_by_type: { ...batchSamples },
          daily_aggregates: dailyAggs,
          workouts: withWorkouts ? workouts : { items: [] },
        }),
      });
      batchSamples = {};
      includeWorkoutsInNext = false;
    };

    for (const item of items) {
      if (batchSamples[item.typeKey]) flushBatch();

      const probe = { ...batchSamples, [item.typeKey]: item.block };
      const withWorkouts = includeWorkoutsInNext && Object.keys(batchSamples).length === 0;
      if (
        Object.keys(batchSamples).length > 0 &&
        estimateBatch(probe, withWorkouts) > MAX_SYNC_POST_BYTES
      ) {
        flushBatch();
      }
      batchSamples[item.typeKey] = item.block;
    }

    if (Object.keys(batchSamples).length > 0 || includeWorkoutsInNext) {
      flushBatch();
    } else if (plans.length === 0 && (dailyAggs.length > 0 || hasWorkouts)) {
      includeWorkoutsInNext = hasWorkouts;
      flushBatch();
    }

    return plans;
  }

  async function postHealthSyncBatched(token, basePayload, sentSamples) {
    const totalBytes = estimateJsonBytes(basePayload);
    if (totalBytes <= MAX_SYNC_POST_BYTES) {
      return postHealthSyncWithRetry(token, basePayload, "monolithe");
    }

    const plans = buildBatchedPostPlans(basePayload);
    log(
      `Envoi en ${plans.length} POST (~${Math.round(totalBytes / 1024)}KB, ${sentSamples ?? "?"} samples) — regroupement par taille…`,
    );

    const bodies = [];
    let authToken = await resolveSyncAccessToken(token);
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const kb = Math.round(estimateJsonBytes(plan.payload) / 1024);
      log(`  POST lot ${i + 1}/${plans.length} (${plan.label}, ~${kb}KB)…`);
      const res = await postHealthSyncWithRetry(token, plan.payload, plan.label, { authToken });
      if (res.token) authToken = res.token;
      if (!res.ok) {
        log(`  Lot ${i + 1} échec — sync partielle annulée`);
        return res;
      }
      if (res.body) bodies.push(res.body);
    }

    return {
      ok: true,
      status: 200,
      body: mergeBatchBodies(bodies),
      token: authToken,
      batched: true,
      batch_count: plans.length,
    };
  }

  async function postHealthSync(token, payload, options) {
    const quiet = !!(options && options.quiet);
    let authToken =
      options?.authToken != null ? options.authToken : await resolveSyncAccessToken(token);
    if (!authToken) {
      return {
        ok: false,
        status: 401,
        body: { detail: "Session expired" },
        error: "Session expired",
      };
    }

    const payloadBytes = (() => {
      try {
        return JSON.stringify(payload).length;
      } catch (_) {
        return null;
      }
    })();

    const doPost = async (bearer) => {
      try {
        return await fetch(SYNC_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(payload),
        });
      } catch (fetchErr) {
        if (!quiet) {
          const detail = formatSyncError(fetchErr, "POST sync");
          if (payloadBytes != null) {
            log(`${detail} | body≈${Math.round(payloadBytes / 1024)}KB`);
          } else {
            log(detail);
          }
        }
        throw fetchErr;
      }
    };

    let res;
    try {
      res = await doPost(authToken);
    } catch (fetchErr) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: formatSyncError(fetchErr, "POST sync"),
        token: authToken,
      };
    }
    if (res.status === 401 && window.PcpHealthBridge?.refreshAccessToken) {
      log("Sync 401 — tentative refresh token…");
      try {
        const renewed = await window.PcpHealthBridge.refreshAccessToken();
        if (renewed) {
          authToken = renewed;
          try {
            res = await doPost(renewed);
          } catch (retryErr) {
            return {
              ok: false,
              status: 0,
              body: null,
              error: formatSyncError(retryErr, "POST sync retry"),
              token: authToken,
            };
          }
        }
      } catch (refreshErr) {
        log(formatSyncError(refreshErr, "refresh token"));
      }
    }

    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }

    if (!res.ok) {
      const detail =
        body?.detail != null
          ? typeof body.detail === "string"
            ? body.detail
            : JSON.stringify(body.detail)
          : raw.slice(0, 800);
      const kb = payloadBytes != null ? Math.round(payloadBytes / 1024) : "?";
      if (res.status >= 500) {
        log(
          `ERREUR SERVEUR HTTP ${res.status} — lot ~${kb}KB | ${String(detail).slice(0, 500)}`,
        );
      } else if (!quiet) {
        log(`POST sync HTTP ${res.status} (~${kb}KB) — ${String(detail).slice(0, 300)}`);
      }
      return { ok: false, status: res.status, body, error: detail, token: authToken };
    }
    return { ok: true, status: res.status, body, token: authToken };
  }

  /**
   * Re-sync j 1–7 après backfill — même logique que la 2ᵉ sync manuelle (phase incremental).
   * Le catch-up + onlyTypes en streaming ne reproduisait pas ce flux.
   */
  async function refreshPriorityScoringRollups(Health, token, options = {}) {
    const quiet = !!options.quiet;
    const lookbackDays = Number(options.days ?? PRIORITY_LOOKBACK_DAYS);
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysToMs(lookbackDays));
    if (!quiet) {
      log(
        `Rafraîchissement rollup scoring j 1–${lookbackDays} (phase incremental, comme sync manuelle)…`,
      );
    }
    log("[sync-session] ROLLUP_REFRESH_PRIORITY début");
    const result = await collectAndStreamPost(Health, startDate, endDate, token, {
      manual: false,
      phase: "incremental",
      repairStrategy: "rollup_refresh_priority_scoring",
    });
    if (result.body) {
      log("──── Réponse backend (rollup incremental) ────");
      logSyncPostResponse(result.body);
    }
    if (result.ok) {
      log(
        `[sync-session] ROLLUP_REFRESH_PRIORITY ok samples=${result.sentSamples ?? 0} aggs=${result.sentAggregates ?? 0}`,
      );
    } else {
      log(
        `[sync-session] ROLLUP_REFRESH_PRIORITY échec ${result.status ?? 0} ${result.error ?? result.reason ?? "unknown"}`,
      );
    }
    return result;
  }

  /**
   * Un seul POST /sync : daily_aggregates (jours calendaires) + samples scoring.
   * Garantit le rollup recovery/stress sur j1–7 même si le streaming a tout mis en doublons.
   */
  async function postRollupTouchSingleShot(Health, token, options = {}) {
    const quiet = !!options.quiet;
    const lookbackDays = Number(options.days ?? PRIORITY_LOOKBACK_DAYS);
    if (!Health || typeof Health.queryAggregated !== "function") {
      return { ok: false, skipped: true, reason: "no_query_aggregated", token };
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysToMs(lookbackDays));
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const endIsoQuery = new Date(endDate.getTime() + 60 * 1000).toISOString();
    const errors = {};
    const readGranted = [];
    const readDenied = [];

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);
    for (const spec of STATISTICS_DAILY_SPECS) {
      if (grantedSet.has(spec.type)) readGranted.push(spec.type);
      else readDenied.push(spec.type);
    }

    let dailyAggsRaw = await fetchDailyAggregatesFromHealthKit(
      Health,
      startIso,
      endIsoQuery,
      errors,
      grantedSet,
    );
    dailyAggsRaw = await fillStepsGapsInDailyAggregates(
      Health,
      dailyAggsRaw,
      startIso,
      endIsoQuery,
      grantedSet,
    );

    let sleepDailyRows = [];
    if (grantedSet.has("sleep")) {
      try {
        const sleepRead = await readAllSleepSamples(Health, startIso, endIsoQuery, { light: true });
        sleepDailyRows = sleepRead.dailyRows ?? [];
      } catch (sleepErr) {
        log(`Rollup touch sommeil: ${formatSyncError(sleepErr, "rollup-touch-sleep")}`);
      }
    }

    let dailyAggregates = mergeFinalDailyAggregates({}, dailyAggsRaw, sleepDailyRows, true);
    dailyAggregates = filterDailyAggregatesForPost(dailyAggregates);
    if (!dailyAggregates.length) {
      return { ok: false, skipped: true, reason: "no_postable_days", token };
    }

    let pluginVersion = "unknown";
    try {
      const v = await Health.getPluginVersion();
      pluginVersion = v?.version ?? "unknown";
    } catch (_) {}

    const baseShell = buildSyncBasePayload({
      syncId: crypto.randomUUID(),
      startIso,
      endIso,
      pluginVersion,
      readGranted,
      readDenied,
      errors,
      hasQueryAggregated: true,
      strategy: "healthkit_rollup_touch_single_shot",
    });

    const scoringBlocks = buildScoringSamplesFromDailyAggregates(dailyAggsRaw);
    const samplesByType = {};
    let sentSamples = 0;
    for (const [type, block] of Object.entries(scoringBlocks)) {
      if (!block?.samples?.length) continue;
      samplesByType[type] = block;
      sentSamples += block.samples.length;
    }

    const payload = payloadShell(baseShell, {
      samples_by_type: samplesByType,
      daily_aggregates: dailyAggregates,
      workouts: { items: [] },
    });

    if (!quiet) {
      log(
        `  Rollup touch 1 lot — aggs=${dailyAggregates.length} j scoring_samples=${sentSamples}…`,
      );
    }
    log("[sync-session] ROLLUP_TOUCH_SINGLE début");
    const res = await postHealthSyncWithRetry(token, payload, "rollup-touch", { quiet });
    if (res?.body) {
      log("──── Réponse backend (rollup touch) ────");
      logSyncPostResponse(res.body);
    }
    if (res?.ok) {
      log(
        `[sync-session] ROLLUP_TOUCH_SINGLE ok aggs=${dailyAggregates.length} scoring_samples=${sentSamples}`,
      );
    } else {
      log(
        `[sync-session] ROLLUP_TOUCH_SINGLE échec ${res?.status ?? 0} ${res?.error ?? res?.reason ?? "unknown"}`,
      );
    }
    return { ...res, sentSamples, sentAggregates: dailyAggregates.length };
  }

  /**
   * Rollup recovery/stress j1–7 — synchrone, juste après backfill (avant backfill-finished).
   * Équivalent à la 2ᵉ sync manuelle, sans timer ni POST /recompute.
   */
  async function finalizeScoringRollupAfterBackfill(Health, token, options = {}) {
    const quiet = !!options.quiet;
    const days = options.rollupDays ?? PRIORITY_LOOKBACK_DAYS;
    let activeToken = token;

    log(`[sync-session] SCORING_ROLLUP_FIN début — rollup j1–${days} post-backfill (bloquant)`);

    async function runOnce() {
      const touch = await postRollupTouchSingleShot(Health, activeToken, { quiet, days });
      activeToken = touch?.token ?? activeToken;
      const rollup = await refreshPriorityScoringRollups(Health, activeToken, { quiet, days });
      activeToken = rollup?.token ?? activeToken;
      return { touch, rollup, ok: !!(touch?.ok && rollup?.ok) };
    }

    let attempt = await runOnce();
    if (!attempt.ok) {
      log(
        `[sync-session] SCORING_ROLLUP_FIN retry immédiat touch=${!!attempt.touch?.ok} incremental=${!!attempt.rollup?.ok}`,
      );
      attempt = await runOnce();
    }

    if (attempt.ok) {
      log(`[sync-session] SCORING_ROLLUP_FIN ok — recovery/stress rollup j1–${days} terminé`);
    } else {
      log(
        `[sync-session] SCORING_ROLLUP_FIN échec touch=${!!attempt.touch?.ok} incremental=${!!attempt.rollup?.ok}`,
      );
    }

    return {
      ok: attempt.ok,
      touch: attempt.touch,
      rollup: attempt.rollup,
      token: activeToken,
    };
  }

  /**
   * Après rollup refresh : réaligne pas/cal/FC repos sur Santé Apple via daily_aggregates.
   */
  async function refreshRecentActivityAggregates(Health, token, options = {}) {
    const quiet = !!options.quiet;
    const lookbackDays = Number(options.days ?? PRIORITY_LOOKBACK_DAYS + 1);
    if (!Health || typeof Health.queryAggregated !== "function") {
      return { ok: false, skipped: true, reason: "no_query_aggregated", token };
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysToMs(lookbackDays));
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const endIsoQuery = new Date(endDate.getTime() + 60 * 1000).toISOString();
    const errors = {};
    const readGranted = [];
    const readDenied = [];

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);
    for (const spec of STATISTICS_DAILY_SPECS) {
      if (grantedSet.has(spec.type)) readGranted.push(spec.type);
      else readDenied.push(spec.type);
    }

    let dailyAggsRaw = await fetchDailyAggregatesFromHealthKit(
      Health,
      startIso,
      endIsoQuery,
      errors,
      grantedSet,
    );
    dailyAggsRaw = await fillStepsGapsInDailyAggregates(
      Health,
      dailyAggsRaw,
      startIso,
      endIsoQuery,
      grantedSet,
    );
    dailyAggsRaw = filterDailyAggregatesForPost(dailyAggsRaw);
    if (!dailyAggsRaw.length) {
      return { ok: true, skipped: true, reason: "no_activity_aggs", token };
    }

    let pluginVersion = "unknown";
    try {
      const v = await Health.getPluginVersion();
      pluginVersion = v?.version ?? "unknown";
    } catch (_) {}

    const baseShell = buildSyncBasePayload({
      syncId: crypto.randomUUID(),
      startIso,
      endIso,
      pluginVersion,
      readGranted,
      readDenied,
      errors,
      hasQueryAggregated: true,
      strategy: "healthkit_activity_refresh_post_rollup",
    });
    const payload = payloadShell(baseShell, {
      samples_by_type: {},
      daily_aggregates: dailyAggsRaw,
      workouts: { items: [] },
    });

    if (!quiet) {
      log(
        `  Rafraîchissement pas/cal post-rollup (${dailyAggsRaw.length} j depuis HK statistics)…`,
      );
    }
    const res = await postHealthSyncWithRetry(token, payload, "activity-refresh", { quiet });
    if (!res?.ok) {
      if (!quiet) {
        log(
          `[sync-session] ACTIVITY_REFRESH échec ${res?.status ?? 0} ${res?.error ?? res?.reason ?? "unknown"}`,
        );
      }
      return res;
    }

    let activeToken = res?.token ?? token;
    let sentSamples = 0;
    try {
      const scoringRes = await postActivityScoringBlocksFromDaily({
        token: activeToken,
        baseShell,
        dailyAggsRaw,
        logPrefix: "activity-refresh",
      });
      activeToken = scoringRes?.token ?? activeToken;
      sentSamples = scoringRes?.sentSamples ?? 0;
    } catch (scoringErr) {
      log(
        `Rafraîchissement scoring post-activité: ${formatSyncError(scoringErr, "activity-refresh-scoring")}`,
      );
    }

    if (!quiet) {
      log(
        `[sync-session] ACTIVITY_REFRESH ok aggs=${dailyAggsRaw.length} scoring_samples=${sentSamples}`,
      );
    }
    return { ...res, token: activeToken, scoringSamples: sentSamples };
  }

  /** Rollup recovery/stress via POST sync (pas POST /recompute — endpoint absent côté backend). */
  async function runScoringRollupRefresh(Health, token, options = {}) {
    let activeToken = token;
    let touch = null;
    let rollup = null;
    let activity = null;
    if (Health) {
      try {
        touch = await postRollupTouchSingleShot(Health, activeToken, {
          quiet: options.quiet,
          days: options.rollupDays ?? PRIORITY_LOOKBACK_DAYS,
        });
        activeToken = touch?.token ?? activeToken;
      } catch (touchErr) {
        log(`Rollup touch single-shot: ${formatSyncError(touchErr, "rollup-touch")}`);
      }
      try {
        rollup = await refreshPriorityScoringRollups(Health, activeToken, {
          quiet: options.quiet,
          days: options.rollupDays ?? PRIORITY_LOOKBACK_DAYS,
        });
        activeToken = rollup?.token ?? activeToken;
      } catch (rollupErr) {
        log(`Rollup refresh priority: ${formatSyncError(rollupErr, "rollup-refresh")}`);
      }
      try {
        activity = await refreshRecentActivityAggregates(Health, activeToken, {
          quiet: options.quiet,
          days: options.activityRefreshDays ?? PRIORITY_LOOKBACK_DAYS + 1,
        });
        activeToken = activity?.token ?? activeToken;
        if (activity?.body) {
          log("──── Réponse backend (activity refresh) ────");
          logSyncPostResponse(activity.body);
        }
      } catch (refreshErr) {
        log(
          `Rafraîchissement activité post-rollup: ${formatSyncError(refreshErr, "activity-refresh")}`,
        );
      }
    }
    const ok = !!(touch?.ok || rollup?.ok || activity?.ok);
    return { ok, touch, rollup, activity, token: activeToken };
  }

  function storeSyncSummary(detail) {
    try {
      sessionStorage.setItem(
        "pcpHealthLastSyncSummary",
        JSON.stringify({
          at: new Date().toISOString(),
          ...detail,
        }),
      );
    } catch (_) {}
  }

  const SYNC_HEARTBEAT_MS = 30 * 1000;
  const SYNC_WARN_SEC = 300;
  const SYNC_CRITICAL_SEC = 600;
  const SYNC_EXTREME_SEC = 3600;

  function beginSyncSessionLog(manual, force, needsAggBackfill, plan, token) {
    const sessionId = crypto.randomUUID().slice(0, 8);
    const startedAt = Date.now();
    window.__pcpSyncSession = { id: sessionId, startedAt, manual };
    const phaseSummary =
      plan?.phases?.map((p) => p.label).join("→") ?? `${FULL_LOOKBACK_DAYS}j`;
    log(`──── Sync session ${sessionId} ────`);
    log(
      `[sync-session] DEBUT manual=${manual} force=${force} mode=${plan?.mode ?? "?"} phases=${phaseSummary} aggBackfill=${needsAggBackfill}`,
    );
    try {
      const planMeta = {
        mode: plan?.mode ?? null,
        phases: plan?.phases?.map((p) => p.label) ?? [],
        at: new Date().toISOString(),
      };
      if (plan?.incrementalWindow) {
        const w = plan.incrementalWindow;
        planMeta.incrementalWindowDays = w.windowDays;
        planMeta.incrementalGapHours = w.gapHours;
        planMeta.incrementalExtendedByGap = w.extendedByGap;
        planMeta.incrementalCompact = true;
        const extNote = w.extendedByGap
          ? `étendue gap=${w.gapHours}h+overlap ${w.overlapHours}h`
          : `plancher ${w.minLookbackHours}h`;
        log(`[sync-session] INCREMENTAL_WINDOW ${w.windowDays}j (${extNote})`);
      } else if (plan?.mode === "incremental" && token) {
        const lastDataSync = parseInt(getSyncScopedItem(LAST_DATA_SYNC_KEY, token) || "0", 10);
        const w = computeIncrementalWindow(lastDataSync);
        planMeta.incrementalWindowDays = w.windowDays;
        planMeta.incrementalGapHours = w.gapHours;
        planMeta.incrementalExtendedByGap = w.extendedByGap;
        const extNote = w.extendedByGap
          ? `étendue gap=${w.gapHours}h+overlap ${w.overlapHours}h`
          : `plancher ${w.minLookbackHours}h`;
        log(`[sync-session] INCREMENTAL_WINDOW ${w.windowDays}j (${extNote})`);
      }
      sessionStorage.setItem("pcpHealthSyncPlanMeta", JSON.stringify(planMeta));
    } catch (_) {}
    log(
      "[sync-session] Bouton « Envoyer les logs » reste visible pendant toute la sync — masqué ~4s après navigation dans l'app",
    );
    if (window.__pcpSyncHeartbeat) {
      window.clearInterval(window.__pcpSyncHeartbeat);
    }
    window.__pcpSyncHeartbeat = window.setInterval(() => {
      if (!window.__pcpHealthSyncRunning) return;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      let warn = "";
      if (elapsed >= SYNC_EXTREME_SEC) {
        warn = " ⚠️ CRITIQUE >1h — build ancien ou profil Watch très dense";
      } else if (elapsed >= SYNC_CRITICAL_SEC) {
        warn = " ⚠️ sync très longue >10min";
      } else if (elapsed >= SYNC_WARN_SEC) {
        warn = " ⚠️ sync longue >5min";
      }
      log(`[sync-session] EN_COURS ${elapsed}s${warn}`);
    }, SYNC_HEARTBEAT_MS);
    return sessionId;
  }

  function endSyncSessionLog(outcome, extra) {
    if (window.__pcpSyncHeartbeat) {
      window.clearInterval(window.__pcpSyncHeartbeat);
      window.__pcpSyncHeartbeat = null;
    }
    const sess = window.__pcpSyncSession;
    const elapsedSec = sess ? Math.round((Date.now() - sess.startedAt) / 1000) : null;
    const tail = extra != null ? ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : "";
    let line = `[sync-session] FIN outcome=${outcome}`;
    if (elapsedSec != null) line += ` duration=${elapsedSec}s`;
    line += tail;
    if (elapsedSec != null && elapsedSec >= SYNC_WARN_SEC) {
      line +=
        " | sync longue — vérifier build TestFlight récent + lignes ERREUR SERVEUR HTTP 500";
    }
    log(line);
    try {
      const meta = {
        id: sess?.id,
        outcome,
        elapsedSec,
        at: new Date().toISOString(),
      };
      if (extra && typeof extra === "object") Object.assign(meta, extra);
      else if (extra != null) meta.detail = extra;
      sessionStorage.setItem("pcpHealthSyncSessionMeta", JSON.stringify(meta));
    } catch (_) {}
    window.__pcpSyncSession = null;
  }

  /**
   * Réparation légère 60 j : relit les pas HealthKit et POST samples + agrégats steps uniquement.
   * Ne relance pas le backfill vitaux/sommeil complet.
   */
  async function runHistoricalStepsRepair(Health, token) {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysToMs(FULL_LOOKBACK_DAYS));
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const endIsoQuery = new Date(endDate.getTime() + 60 * 1000).toISOString();
    const syncId = crypto.randomUUID();
    const errors = {};
    const readGranted = [];
    const readDenied = [];

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);
    if (!grantedSet.has("steps")) {
      log("Réparation pas: permission steps absente");
      return { ok: false, reason: "no_steps_perm", token };
    }
    readGranted.push("steps");

    let pluginVersion = "unknown";
    try {
      const v = await Health.getPluginVersion();
      pluginVersion = v?.version ?? "unknown";
    } catch (_) {}

    const hasQueryAggregated = typeof Health.queryAggregated === "function";
    const dailyAggsFetched = await fetchDailyAggregatesFromHealthKit(
      Health,
      startIso,
      endIsoQuery,
      errors,
      grantedSet,
    );
    const dailyAggsRaw = await fillStepsGapsInDailyAggregates(
      Health,
      dailyAggsFetched,
      startIso,
      endIsoQuery,
      grantedSet,
    );
    const stepRows = dailyAggsRaw.filter((r) => r?.day && Number(r.steps_total) > 0);
    if (stepRows.length === 0) {
      log("Réparation pas: aucun pas HealthKit sur 60 j");
      return { ok: true, skipped: true, reason: "no_steps_in_healthkit", token };
    }

    const scoringBlocks = buildScoringSamplesFromDailyAggregates(dailyAggsRaw);
    const stepsBlock = scoringBlocks.steps;
    if (!stepsBlock?.samples?.length) {
      log("Réparation pas: impossible de construire les samples scoring");
      return { ok: false, reason: "no_steps_block", token };
    }

    const baseShell = buildSyncBasePayload({
      syncId,
      startIso,
      endIso,
      pluginVersion,
      readGranted,
      readDenied,
      errors,
      hasQueryAggregated,
      strategy: "healthkit_steps_repair",
    });

    const postQueue = createPostQueue(token);
    let sentSamples = 0;

    const stepsPayload = payloadShell(baseShell, {
      samples_by_type: { steps: stepsBlock },
      daily_aggregates: activityOverlayDailyAggregates(dailyAggsRaw),
      workouts: { items: [] },
    });
    log(`  POST réparation steps (${stepsBlock.samples.length} jour(s), ~${Math.round(estimateJsonBytes(stepsPayload) / 1024)}KB)…`);
    const stepsRes = await postQueue.push("steps-repair", stepsPayload);
    if (!stepsRes.ok) {
      return { ...stepsRes, token: postQueue.getToken() };
    }
    sentSamples += stepsBlock.samples.length;
    const overlayDays = activityOverlayDailyAggregates(dailyAggsRaw).length;

    log(
      `Réparation pas terminée — ${sentSamples} sample(s), ${overlayDays} jour(s) overlay`,
    );
    return {
      ok: true,
      token: postQueue.getToken(),
      sentSamples,
      sentAggregates: overlayDays,
      body: stepsRes.body,
    };
  }

  /**
   * Réparation 1× fenêtre récente (14 j) : kcal agrégats + samples |agg| pas/cal/FC repos.
   * Comble trous énergie (UI) et effort (fallback calories) sans refaire le backfill 1 an.
   */
  async function runHistoricalActivityCaloriesRepair(Health, token) {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysToMs(RECENT_ACTIVITY_REPAIR_DAYS));
    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();
    const endIsoQuery = new Date(endDate.getTime() + 60 * 1000).toISOString();
    const syncId = crypto.randomUUID();
    const errors = {};
    const readGranted = [];
    const readDenied = [];

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);
    for (const spec of STATISTICS_DAILY_SPECS) {
      if (grantedSet.has(spec.type)) readGranted.push(spec.type);
      else readDenied.push(spec.type);
    }
    if (!grantedSet.has("calories") && !grantedSet.has("steps")) {
      log("Réparation énergie: permissions calories/steps absentes");
      return { ok: false, reason: "no_activity_perm", token };
    }

    let pluginVersion = "unknown";
    try {
      const v = await Health.getPluginVersion();
      pluginVersion = v?.version ?? "unknown";
    } catch (_) {}

    const hasQueryAggregated = typeof Health.queryAggregated === "function";
    let dailyAggsRaw = await fetchDailyAggregatesFromHealthKit(
      Health,
      startIso,
      endIsoQuery,
      errors,
      grantedSet,
    );
    dailyAggsRaw = await fillStepsGapsInDailyAggregates(
      Health,
      dailyAggsRaw,
      startIso,
      endIsoQuery,
      grantedSet,
    );

    const activityRows = (dailyAggsRaw ?? []).filter(
      (row) =>
        row?.day &&
        (Number(row.steps_total) > 0 ||
          Number(row.calories_total_kcal) > 0 ||
          Number(row.resting_heart_rate_avg) > 0),
    );
    if (activityRows.length === 0) {
      log("Réparation énergie: aucune activité HealthKit sur la fenêtre récente");
      return { ok: true, skipped: true, reason: "no_activity_in_healthkit", token };
    }

    const baseShell = buildSyncBasePayload({
      syncId,
      startIso,
      endIso,
      pluginVersion,
      readGranted,
      readDenied,
      errors,
      hasQueryAggregated,
      strategy: "healthkit_activity_calories_repair",
    });

    const postQueue = createPostQueue(token);
    const scoringRes = await postActivityScoringBlocksFromDaily({
      token,
      baseShell,
      dailyAggsRaw: activityRows,
      postQueue,
      logPrefix: "activity-repair",
    });
    if (!scoringRes.ok) {
      return { ...scoringRes, token: postQueue.getToken() };
    }

    const overlay = activityOverlayDailyAggregates(activityRows);
    if (overlay.length > 0) {
      const aggPayload = payloadShell(baseShell, {
        samples_by_type: {},
        daily_aggregates: overlay,
        workouts: { items: [] },
      });
      log(`  POST activity-repair daily_aggregates (${overlay.length} j)…`);
      const aggRes = await postQueue.push("activity-repair-aggs", aggPayload);
      if (!aggRes.ok) {
        return {
          ...aggRes,
          token: postQueue.getToken(),
          sentSamples: scoringRes.sentSamples ?? 0,
        };
      }
    }

    log(
      `Réparation énergie/effort terminée — ${scoringRes.sentSamples ?? 0} sample(s), ${overlay.length} jour(s) overlay`,
    );
    return {
      ok: true,
      token: postQueue.getToken(),
      sentSamples: scoringRes.sentSamples ?? 0,
      sentAggregates: overlay.length,
    };
  }

  async function maybeRepairHistoricalActivityCalories(Health, token, options) {
    if (options?.skipActivityCaloriesRepair || options?.fullLookback) {
      return { applied: false, reason: "skipped_by_options", token };
    }
    if (getSyncScopedItem(ACTIVITY_CALORIES_REPAIR_KEY, token)) {
      return { applied: false, reason: "already_done", token };
    }
    if (!isFullBackfillComplete(token)) {
      return { applied: false, reason: "backfill_incomplete", token };
    }

    const probe = window.PcpHealthServerBackfillProbe;
    if (!probe?.probeServerActivityCaloriesGaps) {
      return { applied: false, reason: "no_probe", token };
    }

    let gaps;
    try {
      gaps = await probe.probeServerActivityCaloriesGaps(token, options);
    } catch (err) {
      log(`Probe calories/effort gaps: ${formatSyncError(err, "activity-calories-gaps")}`);
      return { applied: false, reason: "probe_error", token };
    }

    if (!gaps?.missingCount) {
      setSyncScopedItem(ACTIVITY_CALORIES_REPAIR_KEY, String(Date.now()), token);
      log("Réparation énergie: serveur OK — pas de trou récent kcal/effort");
      log("[sync-session] ACTIVITY_CALORIES_REPAIR skip (rien à réparer)");
      return { applied: false, reason: "no_gaps", token };
    }

    const preview = gaps.missingDays.slice(0, 5).join(", ");
    const more = gaps.missingCount > 5 ? ` +${gaps.missingCount - 5}` : "";
    log(
      `Réparation énergie/effort ${gaps.repairWindowDays ?? RECENT_ACTIVITY_REPAIR_DAYS}j — ${gaps.missingCount} jour(s) (${preview}${more})`,
    );
    log(`[sync-session] ACTIVITY_CALORIES_REPAIR début missing=${gaps.missingCount}`);

    const result = await runHistoricalActivityCaloriesRepair(Health, token);
    if (result.ok && (result.sentSamples ?? 0) > 0) {
      setSyncScopedItem(ACTIVITY_CALORIES_REPAIR_KEY, String(Date.now()), token);
      log(
        `[sync-session] ACTIVITY_CALORIES_REPAIR ok samples=${result.sentSamples ?? 0} aggs=${result.sentAggregates ?? 0}`,
      );
      return { applied: true, ...result };
    }
    if (result.ok && result.skipped) {
      setSyncScopedItem(ACTIVITY_CALORIES_REPAIR_KEY, String(Date.now()), token);
      log("[sync-session] ACTIVITY_CALORIES_REPAIR skip (pas Santé) — retry au prochain sync");
      return { applied: false, ...result };
    }

    log(
      `[sync-session] ACTIVITY_CALORIES_REPAIR échec ${result.error ?? result.reason ?? "unknown"}`,
    );
    return { applied: false, ...result };
  }

  async function maybeRepairHistoricalSteps(Health, token, options) {
    if (options?.skipStepsRepair || options?.fullLookback) {
      return { applied: false, reason: "skipped_by_options", token };
    }
    if (getSyncScopedItem(STEPS_REPAIR_KEY, token)) {
      return { applied: false, reason: "already_done", token };
    }
    if (!isFullBackfillComplete(token)) {
      return { applied: false, reason: "backfill_incomplete", token };
    }

    const probe = window.PcpHealthServerBackfillProbe;
    if (!probe?.probeServerStepsGaps) {
      return { applied: false, reason: "no_probe", token };
    }

    let gaps;
    try {
      gaps = await probe.probeServerStepsGaps(token, options);
    } catch (err) {
      log(`Probe steps gaps: ${formatSyncError(err, "steps-gaps")}`);
      return { applied: false, reason: "probe_error", token };
    }

    if (!gaps?.missingCount) {
      setSyncScopedItem(STEPS_REPAIR_KEY, String(Date.now()), token);
      log("Réparation pas: serveur OK — aucun jour avec signal sans steps_total");
      log("[sync-session] STEPS_REPAIR skip (rien à réparer)");
      return { applied: false, reason: "no_gaps", token };
    }

    const preview = gaps.missingDays.slice(0, 5).join(", ");
    const more = gaps.missingCount > 5 ? ` +${gaps.missingCount - 5}` : "";
    log(
      `Réparation pas ${FULL_LOOKBACK_DAYS}j — ${gaps.missingCount} jour(s) sans steps_total (${preview}${more})`,
    );
    log(`[sync-session] STEPS_REPAIR début missing=${gaps.missingCount}`);

    const result = await runHistoricalStepsRepair(Health, token);
    if (result.ok && (result.sentSamples ?? 0) > 0) {
      setSyncScopedItem(STEPS_REPAIR_KEY, String(Date.now()), token);
      log(
        `[sync-session] STEPS_REPAIR ok samples=${result.sentSamples ?? 0} aggs=${result.sentAggregates ?? 0}`,
      );
      return { applied: true, ...result };
    }
    if (result.ok && result.skipped) {
      log("[sync-session] STEPS_REPAIR skip (pas HealthKit) — retry au prochain sync");
      return { applied: false, ...result };
    }

    log(`[sync-session] STEPS_REPAIR échec ${result.error ?? result.reason ?? "unknown"}`);
    return { applied: false, ...result };
  }

  /**
   * Réparation ciblée j 8–90 : stades sommeil compacts (constance horaires / réparateur).
   * Ne relit pas les vitaux ni les workouts.
   */
  async function runHistoricalSleepStagesRepair(Health, token, options = {}) {
    const missingWakeDays = options?.missingWakeDays;
    const endDate = new Date(Date.now() - daysToMs(PRIORITY_LOOKBACK_DAYS));
    const startDate = new Date(Date.now() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS));
    if (startDate.getTime() >= endDate.getTime()) {
      return { ok: true, skipped: true, reason: "no_historical_window", token };
    }

    const authStatus = await Health.checkAuthorization(HEALTH_AUTH_PERMS);
    const grantedSet = new Set(authStatus?.readAuthorized ?? []);
    if (!grantedSet.has("sleep")) {
      log("Réparation sommeil stades: permission sleep absente");
      return { ok: false, reason: "no_sleep_perm", token };
    }

    if (Array.isArray(missingWakeDays) && missingWakeDays.length === 0) {
      return { ok: true, skipped: true, reason: "no_gaps", token };
    }

    if (Array.isArray(missingWakeDays) && missingWakeDays.length > 0) {
      let activeToken = token;
      let sentSamples = 0;
      const sorted = [...missingWakeDays].sort();
      log(
        `Réparation sommeil stades ciblée — ${sorted.length} nuit(s) sans stades (j 8–${SAMPLE_INTRADAY_LOOKBACK_DAYS})…`,
      );
      for (let i = 0; i < sorted.length; i += SLEEP_STAGES_GAP_BATCH_DAYS) {
        const batchDays = sorted.slice(i, i + SLEEP_STAGES_GAP_BATCH_DAYS);
        const window = wakeDaysToReadWindow(batchDays);
        if (!window) continue;
        const wakeDaySet = new Set(batchDays);
        const sleepRead = await readAllSleepSamples(Health, window.startIso, window.endIso, {
          light: true,
        });
        let samples = buildSleepCompactStagedSamplesFromRaw(sleepRead.raw ?? []);
        samples = filterSleepSamplesForWakeDays(samples, wakeDaySet);
        if (!samples.length) continue;
        const result = await collectAndStreamPost(
          Health,
          new Date(window.startIso),
          new Date(window.endIso),
          activeToken,
          {
            phase: "historical",
            onlyTypes: ["sleep"],
            repairStrategy: "healthkit_sleep_stages_repair_gap",
            prefetchedSleepSamples: samples,
          },
        );
        activeToken = result.token ?? activeToken;
        if (!result.ok) return { ...result, token: activeToken };
        sentSamples += result.sentSamples ?? 0;
      }
      return { ok: true, sentSamples, token: activeToken };
    }

    log(
      `Réparation sommeil stades ${SAMPLE_INTRADAY_LOOKBACK_DAYS - PRIORITY_LOOKBACK_DAYS}j (j 8–${SAMPLE_INTRADAY_LOOKBACK_DAYS}) — mode historicalLight…`,
    );
    return collectAndStreamPost(Health, startDate, endDate, token, {
      phase: "historical",
      onlyTypes: ["sleep"],
      repairStrategy: "healthkit_sleep_stages_repair",
    });
  }

  async function executeSleepStagesRepair(Health, token, coverage, options = {}) {
    const attempts = parseInt(getSyncScopedItem(SLEEP_STAGES_REPAIR_ATTEMPTS_KEY, token) || "0", 10);
    setSyncScopedItem(SLEEP_STAGES_REPAIR_ATTEMPTS_KEY, String(attempts + 1), token);

    const missingWakeDays = coverage?.missingWakeDays;
    const result = await runHistoricalSleepStagesRepair(Health, token, {
      missingWakeDays: Array.isArray(missingWakeDays) ? missingWakeDays : undefined,
    });

    if (result.ok && (result.sentSamples ?? 0) > 0) {
      setSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, String(Date.now()), token);
      log(
        `[sync-session] SLEEP_STAGES_REPAIR ok samples=${result.sentSamples ?? 0} aggs=${result.sentAggregates ?? 0}`,
      );
      window.setTimeout(() => {
        if (window.PcpHealthDisplayRefresh?.scheduleRefreshAfterSync) {
          window.PcpHealthDisplayRefresh.scheduleRefreshAfterSync({
            reason: "sleep-stages-repair",
            pulse: false,
            retryMs: [800, 2000],
          });
        }
      }, 150);
      return { applied: true, ...result };
    }
    if (result.ok && result.skipped) {
      setSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, String(Date.now()), token);
      log("[sync-session] SLEEP_STAGES_REPAIR skip (pas de sommeil HealthKit sur les nuits ciblées)");
      return { applied: false, ...result };
    }

    if (attempts + 1 >= SLEEP_STAGES_REPAIR_MAX_ATTEMPTS) {
      setSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, String(Date.now()), token);
      log(
        `[sync-session] SLEEP_STAGES_REPAIR abandon après ${SLEEP_STAGES_REPAIR_MAX_ATTEMPTS} tentative(s)`,
      );
    }

    log(
      `[sync-session] SLEEP_STAGES_REPAIR échec ${result.error ?? result.reason ?? "unknown"}`,
    );
    return { applied: false, ...result };
  }

  function runBackgroundSleepStagesRepair(Health, token, coverage) {
    if (__pcpSleepStagesRepairRunning) {
      log("Réparation sommeil stades déjà en cours (arrière-plan)");
      return;
    }
    __pcpSleepStagesRepairRunning = true;
    log("[sync-session] SLEEP_STAGES_REPAIR background démarré");
    void (async () => {
      try {
        await executeSleepStagesRepair(Health, token, coverage, { background: true });
      } catch (err) {
        log(`Réparation sommeil stades exception: ${formatSyncError(err, "sleep-stages-repair")}`);
      } finally {
        __pcpSleepStagesRepairRunning = false;
      }
    })();
  }

  async function maybeRepairHistoricalSleepStages(Health, token, options) {
    if (options?.skipSleepStagesRepair || options?.fullLookback) {
      return { applied: false, reason: "skipped_by_options", token };
    }

    const probe = window.PcpHealthServerBackfillProbe;
    if (!probe?.probeServerSleepStagesCoverage) {
      return { applied: false, reason: "no_probe", token };
    }

    let coverage;
    try {
      coverage = await probe.probeServerSleepStagesCoverage(token, options);
    } catch (err) {
      log(`Probe sommeil stades: ${formatSyncError(err, "sleep-stages-probe")}`);
      return { applied: false, reason: "probe_error", token };
    }

    if (!coverage?.needsSleepStagesRepair) {
      if (!getSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, token)) {
        setSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, String(Date.now()), token);
      }
      log(
        `Réparation sommeil stades: couverture OK (${coverage.stagedHistoricalNights ?? 0}/${coverage.historicalSleepNights ?? 0} nuits j 8–${SAMPLE_INTRADAY_LOOKBACK_DAYS})`,
      );
      log("[sync-session] SLEEP_STAGES_REPAIR skip (rien à réparer)");
      return { applied: false, reason: "no_gaps", token };
    }

    const attempts = parseInt(getSyncScopedItem(SLEEP_STAGES_REPAIR_ATTEMPTS_KEY, token) || "0", 10);
    if (attempts >= SLEEP_STAGES_REPAIR_MAX_ATTEMPTS) {
      if (!getSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, token)) {
        setSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, String(Date.now()), token);
      }
      log(
        `[sync-session] SLEEP_STAGES_REPAIR skip (max ${SLEEP_STAGES_REPAIR_MAX_ATTEMPTS} tentative(s) — recovery non impacté)`,
      );
      return { applied: false, reason: "max_attempts", token };
    }

    if (getSyncScopedItem(SLEEP_STAGES_REPAIR_KEY, token)) {
      log("Réparation sommeil stades: reprise (gap persistant malgré tentative précédente)");
    }

    const gapNote =
      coverage.missingWakeDayCount > 0
        ? `, ${coverage.missingWakeDayCount} nuit(s) ciblée(s)`
        : "";
    log(
      `Réparation sommeil stades — ${coverage.stagedHistoricalNights ?? 0}/${coverage.historicalSleepNights ?? 0} nuit(s) avec stades sur j 8–${SAMPLE_INTRADAY_LOOKBACK_DAYS}${gapNote}`,
    );
    log(
      `[sync-session] SLEEP_STAGES_REPAIR début staged=${coverage.stagedHistoricalNights} sleep_nights=${coverage.historicalSleepNights} missing=${coverage.missingWakeDayCount ?? 0}`,
    );

    if (options?.foregroundSleepStagesRepair || options?.manual) {
      return executeSleepStagesRepair(Health, token, coverage, options);
    }

    log("Réparation sommeil stades planifiée en arrière-plan (sync récente non bloquée)");
    log("[sync-session] SLEEP_STAGES_REPAIR background scheduled");
    runBackgroundSleepStagesRepair(Health, token, coverage);
    return { applied: false, scheduled: true, token };
  }

  /** Re-sync j 91–365 pour comptes déjà backfillés sans sommeil/workouts historiques. */
  async function maybeRepairDailyExtendedSleepWorkouts(Health, token, options) {
    if (options?.skipDailyExtendedRepair || options?.fullLookback) {
      return { applied: false, reason: "skipped_by_options", token };
    }
    if (!isFullBackfillComplete(token)) {
      return { applied: false, reason: "backfill_incomplete", token };
    }
    if (getSyncScopedItem(DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY, token)) {
      return { applied: false, reason: "already_done", token };
    }

    const endDate = new Date();
    const sampleStart = new Date(endDate.getTime() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS));
    const dailyStart = new Date(endDate.getTime() - daysToMs(DAILY_AGGREGATE_LOOKBACK_DAYS));
    if (dailyStart.getTime() >= sampleStart.getTime()) {
      setSyncScopedItem(DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY, String(Date.now()), token);
      return { applied: false, reason: "no_window", token };
    }

    log(
      `Réparation agrégats 1 an — re-sync sommeil + vitaux + workouts (j ${SAMPLE_INTRADAY_LOOKBACK_DAYS + 1}–365)`,
    );
    log("[sync-session] DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR début");
    clearDailyExtendedCheckpoint(token);

    const result = await syncDailyExtendedWithCheckpoints(Health, dailyStart, sampleStart, token, {
      manual: !!options?.manual,
    });
    if (result.ok) {
      setSyncScopedItem(DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY, String(Date.now()), token);
      log(
        `[sync-session] DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR ok samples=${result.sentSamples ?? 0} workouts=${result.sentWorkouts ?? 0} aggs=${result.sentAggregates ?? 0}`,
      );
      return { applied: true, ...result };
    }

    log(
      `[sync-session] DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR échec ${result.error ?? result.reason ?? "unknown"}`,
    );
    return { applied: false, ...result };
  }

  /**
   * Réparation 1× j 61–90 : intraday scoring (mode historical) pour comptes backfillés à 60 j.
   * Ces jours avaient été synchronisés en daily-extended (compact) — insuffisant pour charge/Effort.
   */
  async function maybeRepairScoring90dIntraday(Health, token, options) {
    if (options?.skipScoring90Repair || options?.fullLookback) {
      return { applied: false, reason: "skipped_by_options", token };
    }
    if (!isFullBackfillComplete(token)) {
      return { applied: false, reason: "backfill_incomplete", token };
    }
    if (getSyncScopedItem(SCORING_90D_REPAIR_KEY, token)) {
      return { applied: false, reason: "already_done", token };
    }
    if (SAMPLE_INTRADAY_LOOKBACK_DAYS <= PREVIOUS_INTRADAY_LOOKBACK_DAYS) {
      setSyncScopedItem(SCORING_90D_REPAIR_KEY, String(Date.now()), token);
      return { applied: false, reason: "no_migration_needed", token };
    }

    const endDate = new Date(Date.now() - daysToMs(PREVIOUS_INTRADAY_LOOKBACK_DAYS));
    const startDate = new Date(Date.now() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS));
    if (startDate.getTime() >= endDate.getTime()) {
      setSyncScopedItem(SCORING_90D_REPAIR_KEY, String(Date.now()), token);
      return { applied: false, reason: "no_window", token };
    }

    const fromDay = startDate.toISOString().slice(0, 10);
    const toDay = endDate.toISOString().slice(0, 10);
    log(
      `Réparation intraday scoring — re-sync j ${PREVIOUS_INTRADAY_LOOKBACK_DAYS + 1}–${SAMPLE_INTRADAY_LOOKBACK_DAYS} (${fromDay} → ${toDay})…`,
    );
    log("[sync-session] SCORING_90D_REPAIR début");

    const result = await syncHistoricalWithCheckpoints(Health, startDate, endDate, token, {
      manual: !!options?.manual,
    });
    if (result.ok) {
      setSyncScopedItem(SCORING_90D_REPAIR_KEY, String(Date.now()), token);
      log(
        `[sync-session] SCORING_90D_REPAIR ok samples=${result.sentSamples ?? 0} workouts=${result.sentWorkouts ?? 0} aggs=${result.sentAggregates ?? 0}`,
      );
      return { applied: true, ...result };
    }

    log(
      `[sync-session] SCORING_90D_REPAIR échec ${result.error ?? result.reason ?? "unknown"}`,
    );
    return { applied: false, ...result };
  }

  /**
   * Réparation 1× j 8–90 : re-envoie vitaux nuit (HRV, resp, SpO₂, FC repos) pour
   * forcer le rescoring recovery côté backend une fois daily-extended terminé.
   */
  function buildRecoveryRescoreSlices() {
    const endMs = Date.now() - daysToMs(PRIORITY_LOOKBACK_DAYS);
    const startMs = Date.now() - daysToMs(SAMPLE_INTRADAY_LOOKBACK_DAYS);
    if (startMs >= endMs) return [];
    const slices = [];
    let sliceEndMs = endMs;
    while (sliceEndMs > startMs) {
      const sliceStartMs = Math.max(startMs, sliceEndMs - daysToMs(RECOVERY_RESCORE_SLICE_DAYS));
      slices.push({
        startDate: new Date(sliceStartMs),
        endDate: new Date(sliceEndMs),
      });
      sliceEndMs = sliceStartMs;
    }
    return slices;
  }

  /**
   * Réparations 1× + rescoring après backfill terminé (ou skip serveur).
   * Évite d'attendre une 2ᵉ sync manuelle pour remplir recovery/effort/stress.
   */
  async function runPostBackfillRepairPipeline(Health, token, options = {}) {
    let activeToken = token;
    let forceRecompute = false;
    const repairOpts = { manual: false, ...options };

    async function tryRepair(label, fn) {
      try {
        const result = await fn(Health, activeToken, repairOpts);
        activeToken = result?.token ?? activeToken;
        if (result?.applied) forceRecompute = true;
        return result;
      } catch (err) {
        log(`${label} exception: ${formatSyncError(err, label)}`);
        return null;
      }
    }

    log("[sync-session] POST_BACKFILL_PIPELINE début");
    await tryRepair("steps-repair", maybeRepairHistoricalSteps);
    await tryRepair("activity-calories-repair", maybeRepairHistoricalActivityCalories);
    await tryRepair("sleep-stages-repair", maybeRepairHistoricalSleepStages);
    await tryRepair("daily-extended-repair", maybeRepairDailyExtendedSleepWorkouts);
    await tryRepair("scoring-90d-repair", maybeRepairScoring90dIntraday);
    await tryRepair("recovery-rescore-repair", maybeRepairRecoveryRescore);

    try {
      const refresh = await finalizeScoringRollupAfterBackfill(Health, activeToken, {
        quiet: true,
        rollupDays: options?.rollupDays ?? PRIORITY_LOOKBACK_DAYS,
      });
      activeToken = refresh?.token ?? activeToken;
      log("[sync-session] POST_BACKFILL_PIPELINE fin");
      return { token: activeToken, refresh, forceRecompute, rollupOk: !!refresh?.ok };
    } catch (refreshErr) {
      log(`Rollup refresh exception: ${formatSyncError(refreshErr, "rollup-fin")}`);
      log("[sync-session] POST_BACKFILL_PIPELINE fin (rollup échec)");
      return { token: activeToken, refresh: null, forceRecompute, rollupOk: false };
    }
  }

  async function maybeRepairRecoveryRescore(Health, token, options) {
    if (options?.skipRecoveryRescoreRepair || options?.fullLookback) {
      return { applied: false, reason: "skipped_by_options", token };
    }
    if (!isFullBackfillComplete(token)) {
      return { applied: false, reason: "backfill_incomplete", token };
    }
    if (getSyncScopedItem(RECOVERY_RESCORE_REPAIR_KEY, token)) {
      return { applied: false, reason: "already_done", token };
    }

    const slices = buildRecoveryRescoreSlices();
    if (slices.length === 0) {
      setSyncScopedItem(RECOVERY_RESCORE_REPAIR_KEY, String(Date.now()), token);
      return { applied: false, reason: "no_window", token };
    }

    const fromDay = slices[slices.length - 1].startDate.toISOString().slice(0, 10);
    const toDay = slices[0].endDate.toISOString().slice(0, 10);
    log(
      `Réparation recovery — vitaux nuit + sommeil compagnon j ${PRIORITY_LOOKBACK_DAYS + 1}–${SAMPLE_INTRADAY_LOOKBACK_DAYS} (${fromDay} → ${toDay}, ${slices.length} tranche(s))…`,
    );
    log("[sync-session] RECOVERY_RESCORE_REPAIR début");

    const repairTypes = [
      "heartRateVariability",
      "respiratoryRate",
      "oxygenSaturation",
      "restingHeartRate",
    ];
    let activeToken = token;
    let sentSamples = 0;
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i];
      log(
        `Réparation recovery tranche ${i + 1}/${slices.length} (${slice.startDate.toISOString().slice(0, 10)} → ${slice.endDate.toISOString().slice(0, 10)})…`,
      );
      const companions = await buildRecoveryCompanionSleepForSlice(Health, slice, repairTypes);
      if (companions.length > 0) {
        log(`  Sommeil compagnon: ${companions.length} segment(s) pour attribution nocturne`);
      }
      const result = await collectAndStreamPost(
        Health,
        slice.startDate,
        slice.endDate,
        activeToken,
        {
          manual: !!options?.manual,
          phase: "historical",
          onlyTypes: repairTypes,
          repairStrategy: "healthkit_recovery_rescore_repair",
          injectedSleepSamples: companions,
        },
      );
      activeToken = result.token ?? activeToken;
      if (!result.ok) {
        log(
          `[sync-session] RECOVERY_RESCORE_REPAIR échec tranche ${i + 1}/${slices.length} ${result.error ?? result.reason ?? "unknown"}`,
        );
        return { applied: false, ...result, token: activeToken };
      }
      sentSamples += result.sentSamples ?? 0;
    }

    setSyncScopedItem(RECOVERY_RESCORE_REPAIR_KEY, String(Date.now()), activeToken);
    log(`[sync-session] RECOVERY_RESCORE_REPAIR ok samples=${sentSamples} slices=${slices.length}`);
    return { applied: true, ok: true, sentSamples, token: activeToken };
  }

  /** Phase historical (jours 8–90) sans bloquer l'utilisateur après la phase récente. */
  function runBackgroundHistoricalBackfill(Health, phases, token) {
    if (!phases?.length) return;
    if (window.__pcpHealthBackfillRunning) {
      const since = window.__pcpHealthBackfillRunningSince || 0;
      if (since && Date.now() - since < BACKFILL_STUCK_RESET_MS) {
        log("Backfill historique déjà en cours");
        return;
      }
      log("Backfill historique — reset verrou coincé (>30 min)");
      window.__pcpHealthBackfillRunning = false;
    }
    window.__pcpHealthBackfillRunning = true;
    window.__pcpHealthBackfillRunningSince = Date.now();
    log("[sync-session] BACKFILL_ARRIÈRE_PLAN démarré");
    emitSyncEvent("pcp-health-backfill-started", { phases: phases.length });
    let activeToken = token;
    let backfillOk = false;
    let rollupOk = false;
    void (async () => {
      try {
        const serverProbe = window.PcpHealthServerBackfillProbe;
        if (serverProbe?.maybeSkipBackfillFromServer) {
          const skip = await serverProbe.maybeSkipBackfillFromServer(
            buildServerProbeStorage(activeToken, { isBackfillPending: () => true }),
            activeToken,
            {},
          );
          if (skip?.applied) {
            backfillOk = true;
            clearHistoricalCheckpoint(activeToken);
            log("Backfill arrière-plan annulé — historique déjà présent côté serveur");
            log("[sync-session] BACKFILL_ARRIÈRE_PLAN skip (serveur OK)");
            const pipeline = await runPostBackfillRepairPipeline(Health, activeToken, { manual: false });
            activeToken = pipeline?.token ?? activeToken;
            rollupOk = !!pipeline?.rollupOk;
            return;
          }
        }

        let allOk = true;
        for (let pi = 0; pi < phases.length; pi++) {
          const phase = phases[pi];
          const windowDays = syncWindowDays(phase.startDate, phase.endDate);
          log(`Backfill arrière-plan ${pi + 1}/${phases.length} (${phase.label}, ${windowDays}j)…`);
          log(`[sync-session] BACKFILL_PHASE ${pi + 1}/${phases.length} ${phase.label} ${windowDays}j`);
          const streamResult =
            phase.label === "historical"
              ? await syncHistoricalWithCheckpoints(
                  Health,
                  phase.startDate,
                  phase.endDate,
                  activeToken,
                  { manual: false, bg: true },
                )
              : phase.label === "daily-extended"
                ? await syncDailyExtendedWithCheckpoints(
                    Health,
                    phase.startDate,
                    phase.endDate,
                    activeToken,
                    { manual: false, bg: true },
                  )
                : await collectAndStreamPost(Health, phase.startDate, phase.endDate, activeToken, {
                    manual: false,
                    phase: `bg-${phase.label}`,
                  });
          activeToken = streamResult.token ?? activeToken;
          if (!streamResult.ok) {
            allOk = false;
            log(`Backfill arrière-plan échec HTTP ${streamResult.status}: ${streamResult.error}`);
            if (streamResult.status >= 500) {
              log(`[sync-session] BACKFILL_ERREUR_SERVEUR HTTP ${streamResult.status} phase=${phase.label}`);
            } else if (streamResult.readTruncated?.length) {
              log(
                `[sync-session] BACKFILL_ARRIÈRE_PLAN tronqué phase=${phase.label} types=${streamResult.readTruncated.join(",")}`,
              );
            } else {
              log(`[sync-session] BACKFILL_ARRIÈRE_PLAN échec phase=${phase.label} status=${streamResult.status || 0}`);
            }
            break;
          }
        }
        if (allOk) {
          clearHistoricalCheckpoint(activeToken);
          clearDailyExtendedCheckpoint(activeToken);
          setSyncScopedItem(FULL_BACKFILL_KEY, String(Date.now()), activeToken);
          setHistoricalBackfillPending(activeToken, false);
          const pipeline = await runPostBackfillRepairPipeline(Health, activeToken, { manual: false });
          activeToken = pipeline?.token ?? activeToken;
          rollupOk = !!pipeline?.rollupOk;
          log(
            `Backfill journalier ${DAILY_AGGREGATE_LOOKBACK_DAYS}j terminé — prochaines syncs en mode incrémental (${INCREMENTAL_LOOKBACK_HOURS}h)`,
          );
          log("[sync-session] BACKFILL_ARRIÈRE_PLAN ok");
        }
        backfillOk = allOk;
        if (!allOk) {
          log("[sync-session] BACKFILL_ARRIÈRE_PLAN échec — bandeau reste visible, swipe pour reprendre");
        }
      } catch (err) {
        backfillOk = false;
        log(`Backfill arrière-plan exception: ${formatSyncError(err, "backfill")}`);
        log("[sync-session] BACKFILL_ARRIÈRE_PLAN exception");
        log("[sync-session] BACKFILL_ARRIÈRE_PLAN échec — bandeau reste visible, swipe pour reprendre");
      } finally {
        window.__pcpHealthBackfillRunning = false;
        window.__pcpHealthBackfillRunningSince = 0;
        emitSyncEvent("pcp-health-backfill-finished", { ok: backfillOk, rollupOk });
        const pendingManual = window.__pcpPendingManualSync;
        if (pendingManual) {
          window.__pcpPendingManualSync = null;
          const pendingToken = typeof pendingManual === "string" ? pendingManual : activeToken;
          if (pendingToken && window.PcpHealthIosSync?.run) {
            log("Sync manuelle en attente — relance après backfill historique");
            window.setTimeout(() => {
              void window.PcpHealthIosSync.run(pendingToken, {
                manual: true,
                force: true,
                skipAuthCheck: true,
              });
            }, 600);
          }
        }
      }
    })();
  }

  async function run(token, options) {
    const manual = !!(options && options.manual);
    const force = !!(options && options.force);
    const skipAuthCheck = !!(options && options.skipAuthCheck);

    if (window.__pcpHealthSyncRunning || (manual && window.__pcpHealthBackfillRunning)) {
      const now = Date.now();
      if (!window.__pcpHealthBusyLogAt || now - window.__pcpHealthBusyLogAt > 2500) {
        window.__pcpHealthBusyLogAt = now;
        const reason = window.__pcpHealthBackfillRunning
          ? `backfill historique ${SAMPLE_INTRADAY_LOOKBACK_DAYS} j en cours — swipe ignoré`
          : "Sync iOS déjà en cours — swipe ignoré jusqu'à la fin du POST";
        log(reason);
        log("[sync-session] BUSY — une sync est déjà en cours (swipe ignoré, logs conservés)");
      }
      const busy = { skipped: true, manual, reason: "busy" };
      if (manual) {
        try {
          window.__pcpPendingManualSync = token || true;
        } catch {
          /* bridge */
        }
        if (!window.__pcpHealthBusyToastAt || now - window.__pcpHealthBusyToastAt > 3000) {
          window.__pcpHealthBusyToastAt = now;
          emitSyncEvent("pcp-health-sync-finished", busy);
        }
      }
      return busy;
    }

    ensureSyncPatientScope(token);
    try {
      await hydrateSyncStateFromNative(token);
    } catch (hydrateErr) {
      log(`Hydratation état sync native: ${formatSyncError(hydrateErr, "hydrate")}`);
    }
    reconcileLocalBackfillState(token);
    let needsAggBackfill = !getSyncScopedItem(AGGREGATES_BACKFILL_KEY, token);
    if (needsAggBackfill) {
      setSyncScopedItem(AGGREGATES_BACKFILL_KEY, "1", token);
    }
    const lastDataSync = parseInt(getSyncScopedItem(LAST_DATA_SYNC_KEY, token) || "0", 10);
    if (!force && !needsAggBackfill && lastDataSync > 0 && Date.now() - lastDataSync < MIN_SYNC_INTERVAL_MS) {
      log("Sync iOS skip (intervalle 6h — dernière sync avec données OK)");
      return { skipped: true, reason: "interval", manual };
    }

    const serverProbe = window.PcpHealthServerBackfillProbe;
    if (serverProbe?.maybeSkipBackfillFromServer && !options?.fullLookback) {
      try {
        await serverProbe.maybeSkipBackfillFromServer(
          buildServerProbeStorage(token),
          token,
          options,
        );
      } catch (probeErr) {
        log(`Probe serveur backfill: ${formatSyncError(probeErr, "probe")}`);
      }
      if (isFullBackfillComplete(token)) {
        clearHistoricalCheckpoint(token);
      }
    }

    let syncPlan = resolveSyncPlan({ ...options, token });
    syncPlan = await maybeAppendDailyExtendedCatchup(token, syncPlan, options);
    const BACKGROUND_PHASE_LABELS = new Set(["historical", "daily-extended"]);
    const foregroundPhases = syncPlan.phases.filter((p) => !BACKGROUND_PHASE_LABELS.has(p.label));
    const backgroundPhases = syncPlan.phases.filter((p) => BACKGROUND_PHASE_LABELS.has(p.label));
    const activePhases = foregroundPhases.length > 0 ? foregroundPhases : syncPlan.phases;
    const backfillPending = backgroundPhases.length > 0 && foregroundPhases.length > 0;
    window.__pcpHealthSyncRunning = true;
    beginSyncSessionLog(manual, force, needsAggBackfill, syncPlan, token);
    const stuckResetTimer = window.setTimeout(() => {
      if (window.__pcpHealthSyncRunning) {
        const min = Math.round(SYNC_STUCK_RESET_MS / 60000);
        log(`Sync bloquée trop longtemps — reset du verrou après ${min}min`);
        log(
          `[sync-session] ALERTE verrou reset après ${min}min — la sync peut encore tourner ; bouton logs toujours actif`,
        );
        window.__pcpHealthSyncRunning = false;
      }
    }, SYNC_STUCK_RESET_MS);
    if (manual) emitSyncEvent("pcp-health-sync-started", { manual: true });
    let syncFinishEvent = null;
    try {
      if (needsAggBackfill) {
        log("Backfill agrégats journaliers (1× après mise à jour)…");
      }
      const Health = window.Capacitor?.Plugins?.Health;
      if (!Health) throw new Error("Plugin Health introuvable");

      if (manual && !skipAuthCheck) {
        const { granted } = await requestHealthAuthForManualSync();
        if (!granted) {
          log("Sync manuelle annulée : accès Santé non accordé");
          endSyncSessionLog("no_health_auth");
          const denied = { ok: false, reason: "no_health_auth", manual };
          emitSyncEvent("pcp-health-sync-finished", denied);
          return denied;
        }
      }

      const syncStartedAt = Date.now();
      let activeToken = token;
      let forceRecomputeAfterSync = !!options?.forceRecompute;
      try {
        const stepsRepair = await maybeRepairHistoricalSteps(Health, activeToken, options);
        activeToken = stepsRepair?.token ?? activeToken;
        if (stepsRepair?.applied) forceRecomputeAfterSync = true;
      } catch (repairErr) {
        log(`Réparation pas exception: ${formatSyncError(repairErr, "steps-repair")}`);
      }
      try {
        const activityRepair = await maybeRepairHistoricalActivityCalories(Health, activeToken, options);
        activeToken = activityRepair?.token ?? activeToken;
        if (activityRepair?.applied) forceRecomputeAfterSync = true;
      } catch (activityRepairErr) {
        log(
          `Réparation énergie exception: ${formatSyncError(activityRepairErr, "activity-calories-repair")}`,
        );
      }
      try {
        const sleepRepair = await maybeRepairHistoricalSleepStages(Health, activeToken, options);
        activeToken = sleepRepair?.token ?? activeToken;
      } catch (sleepRepairErr) {
        log(`Réparation sommeil stades exception: ${formatSyncError(sleepRepairErr, "sleep-stages-repair")}`);
      }
      try {
        const dailyRepair = await maybeRepairDailyExtendedSleepWorkouts(Health, activeToken, options);
        activeToken = dailyRepair?.token ?? activeToken;
        if (dailyRepair?.applied) forceRecomputeAfterSync = true;
      } catch (dailyRepairErr) {
        log(
          `Réparation agrégats 1 an exception: ${formatSyncError(dailyRepairErr, "daily-extended-repair")}`,
        );
      }
      try {
        const scoringRepair = await maybeRepairScoring90dIntraday(Health, activeToken, options);
        activeToken = scoringRepair?.token ?? activeToken;
        if (scoringRepair?.applied) forceRecomputeAfterSync = true;
      } catch (scoringRepairErr) {
        log(
          `Réparation intraday scoring 90j exception: ${formatSyncError(scoringRepairErr, "scoring-90d-repair")}`,
        );
      }
      try {
        const recoveryRepair = await maybeRepairRecoveryRescore(Health, activeToken, options);
        activeToken = recoveryRepair?.token ?? activeToken;
        if (recoveryRepair?.applied) forceRecomputeAfterSync = true;
      } catch (recoveryRepairErr) {
        log(
          `Réparation recovery exception: ${formatSyncError(recoveryRepairErr, "recovery-rescore-repair")}`,
        );
      }
      let merged = null;
      let lastPayload = null;
      let streamResult = null;
      let sentSamples = 0;
      let sentWorkouts = 0;
      let sentAggregates = 0;

      for (let pi = 0; pi < activePhases.length; pi++) {
        const phase = activePhases[pi];
        const windowDays = syncWindowDays(phase.startDate, phase.endDate);
        log(
          `Sync phase ${pi + 1}/${activePhases.length} (${phase.label}, ${windowDays}j) — lecture + POST…`,
        );
        log(`[sync-session] PHASE ${pi + 1}/${activePhases.length} ${phase.label} ${windowDays}j`);

        streamResult =
          phase.label === "historical"
            ? await syncHistoricalWithCheckpoints(
                Health,
                phase.startDate,
                phase.endDate,
                activeToken,
                { manual },
              )
            : phase.label === "daily-extended"
              ? await syncDailyExtendedWithCheckpoints(
                  Health,
                  phase.startDate,
                  phase.endDate,
                  activeToken,
                  { manual },
                )
              : await collectAndStreamPost(Health, phase.startDate, phase.endDate, activeToken, {
                  manual,
                  phase: phase.label,
                });
        activeToken = streamResult.token ?? activeToken;
        lastPayload = streamResult.payload ?? lastPayload;
        sentSamples += streamResult.sentSamples || 0;
        sentWorkouts += streamResult.sentWorkouts || 0;
        sentAggregates = Math.max(sentAggregates, streamResult.sentAggregates || 0);
        merged = mergeStreamPhaseResults(merged, streamResult);

        if (!streamResult.ok) {
          log(`Sync iOS échec HTTP ${streamResult.status} (phase ${phase.label}): ${streamResult.error}`);
          if (streamResult.status >= 500) {
            log(
              `[sync-session] ERREUR_SERVEUR HTTP ${streamResult.status} — possible timeout backend (phase ${phase.label})`,
            );
          }
          if (pi > 0 && (merged?.sentSamples > 0 || merged?.sentWorkouts > 0)) {
            const partialAt = String(Date.now());
            setSyncScopedItem(LAST_DATA_SYNC_KEY, partialAt, activeToken || token);
            sessionStorage.setItem("pcpHealthLastSyncAt", partialAt);
            log("Données récentes déjà envoyées — historique à reprendre au prochain essai");
          }
          endSyncSessionLog("http_error", {
            status: streamResult.status,
            error: String(streamResult.error ?? "").slice(0, 500),
            sentSamples,
            phase: phase.label,
            batch_count: streamResult.batch_count,
          });
          const failed = {
            ok: false,
            status: streamResult.status,
            body: streamResult.body,
            manual,
            error: streamResult.error,
            reason: streamResult.status === 401 ? "auth_expired" : undefined,
            partial: pi > 0,
          };
          storeSyncSummary({ ...failed, sentSamples, sentWorkouts, sentAggregates });
          if (manual) emitSyncEvent("pcp-health-sync-finished", failed);
          return failed;
        }

        if (
          (streamResult.sentSamples > 0 ||
            streamResult.sentWorkouts > 0 ||
            streamResult.sentAggregates > 0) &&
          phase.label !== "historical"
        ) {
          const phaseOkAt = String(Date.now());
          setSyncScopedItem(LAST_DATA_SYNC_KEY, phaseOkAt, activeToken || token);
          sessionStorage.setItem("pcpHealthLastSyncAt", phaseOkAt);
          if (backfillPending && pi === activePhases.length - 1) {
            log("Phase récente OK — données à jour ; historique démarre en arrière-plan");
            emitSyncEvent("pcp-health-priority-sync-finished", {
              ok: true,
              sentSamples,
              sentWorkouts,
              sentAggregates,
            });
          }
        }
      }

      if (sentSamples === 0 && sentWorkouts === 0 && sentAggregates === 0) {
        log("Aucune donnée HealthKit — pas d'envoi backend (réessai possible)");
        endSyncSessionLog("empty", { sentSamples, sentWorkouts, sentAggregates });
        const empty = { ok: false, empty: true, reason: "no_data", manual };
        storeSyncSummary({ ok: false, reason: "no_data", manual, sentSamples, sentWorkouts, sentAggregates });
        if (manual) emitSyncEvent("pcp-health-sync-finished", empty);
        return empty;
      }

      if (lastPayload) {
        logOutboundSummary(lastPayload, sentSamples, sentWorkouts, sentAggregates);
      }

      if (streamResult?.batched) {
        log(`Sync POST terminée (${merged?.batch_count ?? streamResult.batch_count} lot(s) streaming)`);
      }
      const body = streamResult?.body;
      const syncedAt = String(Date.now());
      setSyncScopedItem(LAST_DATA_SYNC_KEY, syncedAt, activeToken || token);
      sessionStorage.setItem("pcpHealthLastSyncAt", syncedAt);
      setSyncScopedItem(AGGREGATES_BACKFILL_KEY, "1", activeToken || token);
      if (
        !backfillPending &&
        syncPlan.phases.some((p) => BACKGROUND_PHASE_LABELS.has(p.label)) &&
        (streamResult?.historicalComplete || streamResult?.dailyExtendedComplete || streamResult?.ok)
      ) {
        clearHistoricalCheckpoint(activeToken || token);
        clearDailyExtendedCheckpoint(activeToken || token);
        setSyncScopedItem(FULL_BACKFILL_KEY, syncedAt, activeToken || token);
        setSyncScopedItem(SCORING_90D_REPAIR_KEY, syncedAt, activeToken || token);
        log(
          `Backfill journalier ${DAILY_AGGREGATE_LOOKBACK_DAYS}j terminé — prochaines syncs en mode incrémental (${INCREMENTAL_LOOKBACK_HOURS}h)`,
        );
      }
      if (backfillPending) {
        setHistoricalBackfillPending(activeToken || token, true);
        runBackgroundHistoricalBackfill(Health, backgroundPhases, activeToken);
      } else if (syncPlan.phases.some((p) => BACKGROUND_PHASE_LABELS.has(p.label))) {
        setHistoricalBackfillPending(activeToken || token, false);
      }
      if (!backfillPending) {
        if (forceRecomputeAfterSync) {
          try {
            const refresh = await runScoringRollupRefresh(Health, activeToken || token, {
              authToken: activeToken || token,
              quiet: true,
            });
            activeToken = refresh?.token ?? activeToken;
            if (refresh?.ok) {
              log(`[sync-session] ROLLUP_REFRESH ok j 1–${PRIORITY_LOOKBACK_DAYS} (post-réparation)`);
            } else {
              log(
                `[sync-session] ROLLUP_REFRESH échec ${refresh?.rollup?.status ?? 0} ${refresh?.rollup?.error ?? refresh?.rollup?.reason ?? "unknown"}`,
              );
            }
          } catch (refreshErr) {
            log(`Rollup refresh exception: ${formatSyncError(refreshErr, "rollup-refresh")}`);
          }
        } else {
          log(
            "[sync-session] ROLLUP_REFRESH skip (rollup déjà fait par POST sync — pas de /recompute)",
          );
        }
      }
      logSyncPostResponse(body);
      const totalSec = Math.round((Date.now() - syncStartedAt) / 1000);
      const durationMsg = backfillPending
        ? `Sync données récentes en ${totalSec}s — historique en arrière-plan`
        : `Sync totale en ${totalSec}s (${syncPlan.mode}) — UI débloquée`;
      log(durationMsg);
      endSyncSessionLog("ok", {
        sentSamples,
        sentWorkouts,
        sentAggregates,
        mode: syncPlan.mode,
        backfillPending,
        batch_count: merged?.batch_count ?? streamResult?.batch_count,
        streaming: !!merged?.streaming,
      });

      const pendingNow = isHistoricalBackfillPending(activeToken || token);
      const success = {
        ok: true,
        sentSamples,
        sentWorkouts,
        sentAggregates,
        body,
        manual,
        token: activeToken,
        prefetch: null,
        mode: syncPlan.mode,
        backfillPending: pendingNow,
      };
      storeSyncSummary({
        ok: true,
        sentSamples,
        sentWorkouts,
        sentAggregates,
        sync_id: lastPayload?.sync_id,
      });
      const deferUiRefresh =
        pendingNow ||
        window.__pcpHealthBackfillRunning ||
        isHistoricalBackfillPending(activeToken || token);
      syncFinishEvent = { ...success, manual, readyForUiRefresh: !deferUiRefresh };

      return success;
    } catch (err) {
      const detail = formatSyncError(err, manual ? "sync-manual" : "sync-auto");
      log(`Sync iOS exception: ${detail}`);
      endSyncSessionLog("exception", { error: detail });
      const errorResult = { ok: false, error: detail, manual };
      storeSyncSummary({ ok: false, error: detail, manual });
      if (manual) emitSyncEvent("pcp-health-sync-finished", errorResult);
      return errorResult;
    } finally {
      window.clearTimeout(stuckResetTimer);
      if (window.__pcpSyncHeartbeat) {
        window.clearInterval(window.__pcpSyncHeartbeat);
        window.__pcpSyncHeartbeat = null;
      }
      window.__pcpHealthSyncRunning = false;
      if (syncFinishEvent) {
        emitSyncEvent("pcp-health-sync-finished", syncFinishEvent);
      }
      const pendingManual = window.__pcpPendingManualSync;
      if (pendingManual && !manual) {
        const pendingToken = typeof pendingManual === "string" ? pendingManual : token;
        if (window.__pcpHealthBackfillRunning || isHistoricalBackfillPending(token)) {
          log("Sync manuelle en attente — reprise après backfill historique");
        } else {
          window.__pcpPendingManualSync = null;
          if (pendingToken && window.PcpHealthIosSync?.run) {
            log("Sync manuelle en attente — relance après sync auto en cours");
            window.setTimeout(() => {
              void window.PcpHealthIosSync.run(pendingToken, {
                manual: true,
                force: true,
                skipAuthCheck: true,
              });
            }, 600);
          }
        }
      } else if (pendingManual && manual) {
        window.__pcpPendingManualSync = null;
      }
    }
  }

  window.PcpHealthSyncStorage = {
    LAST_DATA_SYNC_KEY,
    FULL_BACKFILL_KEY,
    BACKFILL_PENDING_KEY,
    HISTORICAL_CHECKPOINT_KEY,
    STEPS_REPAIR_KEY,
    ACTIVITY_CALORIES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_KEY,
    SLEEP_STAGES_REPAIR_ATTEMPTS_KEY,
    DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY,
    SCORING_90D_REPAIR_KEY,
    RECOVERY_RESCORE_REPAIR_KEY,
    getItem: getSyncScopedItem,
    setItem: setSyncScopedItem,
    ensurePatientScope: ensureSyncPatientScope,
    patientIdFromToken: patientIdFromAccessToken,
    isBackfillPending: isHistoricalBackfillPending,
    isFullBackfillComplete,
    hydrateFromNative: hydrateSyncStateFromNative,
    NATIVE_PERSIST_KEYS,
  };

  window.PcpHealthIosSync = {
    run,
    buildPayload,
    requestHealthAuthForManualSync,
    resolveSyncPlan,
    probeServerBackfill: (token, options) =>
      window.PcpHealthServerBackfillProbe?.maybeSkipBackfillFromServer?.(
        buildServerProbeStorage(token),
        token,
        options,
      ),
  };
})();
