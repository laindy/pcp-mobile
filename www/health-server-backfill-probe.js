/**
 * Probe serveur — évite de relancer le backfill 1 an si les agrégats journaliers
 * couvrent déjà l'historique (sessionStorage perdu, backfill interrompu, autre appareil).
 */
(function () {
  const SYNC_CONST = window.PcpHealthSyncConstants || {};
  const FULL_LOOKBACK_DAYS = SYNC_CONST.FULL_LOOKBACK_DAYS ?? SYNC_CONST.DAILY_AGGREGATE_LOOKBACK_DAYS ?? 365;
  const MIN_DAYS_WITH_SIGNAL = SYNC_CONST.MIN_DAYS_WITH_SIGNAL ?? 210;
  /** Profil épars (peu de jours avec pas) : span 1 an + batches sync suffisent. */
  const MIN_SPARSE_DAYS_WITH_SIGNAL = SYNC_CONST.MIN_SPARSE_DAYS_WITH_SIGNAL ?? 14;
  const MIN_SPAN_DAYS = SYNC_CONST.MIN_SPAN_DAYS ?? 330;
  const OLDEST_SLACK_DAYS = SYNC_CONST.OLDEST_SLACK_DAYS ?? 14;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  /** Fenêtre récente (stades complets) — aligné health-ios-sync.js */
  const PRIORITY_LOOKBACK_DAYS = SYNC_CONST.PRIORITY_LOOKBACK_DAYS ?? 7;
  const SAMPLE_INTRADAY_LOOKBACK_DAYS = SYNC_CONST.SAMPLE_INTRADAY_LOOKBACK_DAYS ?? 90;
  /** Nuits avec stades réels requises sur j 8–{intraday} (constance / réparateur). */
  const MIN_HISTORICAL_STAGED_NIGHTS = 20;
  /** En dessous : pas assez de nuits pour exiger l'historique stades. */
  const MIN_HISTORICAL_SLEEP_NIGHTS_TO_REQUIRE = 10;
  const SLEEP_SAMPLES_PROBE_MAX_PAGES = 16;
  const SYNTHETIC_SLEEP_PLATFORM_RE = /^sleep\|agg\|/i;
  const HIST_COMPACT_SLEEP_PLATFORM_RE = /^sleep\|hist\|/i;

  function formatDateOnly(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function addDaysToIso(dayStr, delta) {
    const parts = String(dayStr).split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return dayStr;
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    dt.setDate(dt.getDate() + delta);
    return formatDateOnly(dt);
  }

  function daysBetweenIso(a, b) {
    const pa = String(a).split("-").map(Number);
    const pb = String(b).split("-").map(Number);
    if (pa.length !== 3 || pb.length !== 3) return 0;
    const t1 = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
    const t2 = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
    return Math.round(Math.abs(t2 - t1) / MS_PER_DAY);
  }

  function dailyRowHasSignal(row) {
    if (!row || typeof row !== "object") return false;
    if (Number(row.steps_total) > 0) return true;
    if (Number(row.sleep_total_min) > 0) return true;
    if (row.hrv_avg_ms != null && Number(row.hrv_avg_ms) > 0) return true;
    if (row.calories_total_kcal != null && Number(row.calories_total_kcal) > 0) return true;
    if (row.resting_heart_rate_avg != null && Number(row.resting_heart_rate_avg) > 0) return true;
    return false;
  }

  /** Jour avec signal vitaux/sommeil/calories mais steps_total absent (bug sync compact). */
  function dayRowMissingSteps(row) {
    if (!row?.day) return false;
    if (row.steps_total != null && Number(row.steps_total) > 0) return false;
    if (Number(row.sleep_total_min) > 0) return true;
    if (row.calories_total_kcal != null && Number(row.calories_total_kcal) > 0) return true;
    if (row.hrv_avg_ms != null && Number(row.hrv_avg_ms) > 0) return true;
    if (row.resting_heart_rate_avg != null && Number(row.resting_heart_rate_avg) > 0) return true;
    if (row.respiratory_rate_avg != null && Number(row.respiratory_rate_avg) > 0) return true;
    if (row.oxygen_saturation_avg != null && Number(row.oxygen_saturation_avg) > 0) return true;
    return false;
  }

  function evaluateStepsGaps(rows) {
    const missingDays = [];
    if (!Array.isArray(rows)) {
      return { missingCount: 0, missingDays, rowCount: 0 };
    }
    for (const row of rows) {
      if (dayRowMissingSteps(row)) missingDays.push(row.day);
    }
    return {
      missingCount: missingDays.length,
      missingDays: missingDays.sort(),
      rowCount: rows.length,
    };
  }

  function evaluateCoverage(rows, dayFromStr, batchTotal) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        sufficient: false,
        reason: "empty",
        daysWithData: 0,
        rowCount: 0,
        oldestDay: null,
        newestDay: null,
        spanDays: 0,
        sparseProfile: false,
      };
    }

    let daysWithData = 0;
    let oldestDay = null;
    let newestDay = null;
    for (const r of rows) {
      const d = r?.day;
      if (!d) continue;
      if (dailyRowHasSignal(r)) daysWithData += 1;
      if (!oldestDay || d < oldestDay) oldestDay = d;
      if (!newestDay || d > newestDay) newestDay = d;
    }

    const spanDays =
      oldestDay && newestDay ? daysBetweenIso(oldestDay, newestDay) + 1 : rows.length;
    const oldestThreshold = addDaysToIso(dayFromStr, OLDEST_SLACK_DAYS);
    const oldestOk = !!(oldestDay && oldestDay <= oldestThreshold);
    const denseSufficient =
      daysWithData >= MIN_DAYS_WITH_SIGNAL && (oldestOk || spanDays >= MIN_SPAN_DAYS);
    const batchesOk = typeof batchTotal === "number" && batchTotal > 0;
    const sparseSufficient =
      batchesOk &&
      oldestOk &&
      spanDays >= MIN_SPAN_DAYS &&
      daysWithData >= MIN_SPARSE_DAYS_WITH_SIGNAL;
    const sufficient = denseSufficient || sparseSufficient;

    return {
      sufficient,
      reason: sufficient
        ? sparseSufficient && !denseSufficient
          ? "ok_sparse"
          : "ok"
        : "insufficient_coverage",
      daysWithData,
      rowCount: rows.length,
      oldestDay,
      newestDay,
      spanDays,
      oldestOk,
      sparseProfile: sparseSufficient && !denseSufficient,
      dayFrom: dayFromStr,
    };
  }

  async function probeServerHistoricalCoverage(token, options) {
    if (!token) {
      return { sufficient: false, reason: "no_token", daysWithData: 0 };
    }

    const lookbackDays =
      (options && options.lookbackDays) || FULL_LOOKBACK_DAYS;
    const dayFrom = new Date(Date.now() - lookbackDays * MS_PER_DAY);
    const dayFromStr = formatDateOnly(dayFrom);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };

    try {
      const url =
        `/api/v1/patients/me/health/daily?day_from=${encodeURIComponent(dayFromStr)}&limit=${lookbackDays}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        return {
          sufficient: false,
          reason: `http_${res.status}`,
          daysWithData: 0,
          dayFrom: dayFromStr,
        };
      }
      const rows = await res.json();

      let batchTotal = null;
      try {
        const batchRes = await fetch(
          "/api/v1/patients/me/health/sync-batches?page_size=1",
          { headers },
        );
        if (batchRes.ok) {
          const batchBody = await batchRes.json();
          batchTotal = typeof batchBody?.total === "number" ? batchBody.total : null;
        }
      } catch (_) {
        /* optional */
      }

      const coverage = evaluateCoverage(rows, dayFromStr, batchTotal);
      return { ...coverage, batchTotal, rows };
    } catch (err) {
      return {
        sufficient: false,
        reason: String(err?.message ?? err).slice(0, 200) || "fetch_error",
        daysWithData: 0,
        dayFrom: dayFromStr,
        rows: [],
      };
    }
  }

  async function probeServerStepsGaps(token, options) {
    const probe = await probeServerHistoricalCoverage(token, options);
    const gaps = evaluateStepsGaps(probe.rows);
    return { ...gaps, dayFrom: probe.dayFrom, sufficient: probe.sufficient };
  }

  function localDayKeyFromIso(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return formatDateOnly(d);
  }

  function historicalCutoffDayStr() {
    const d = new Date();
    d.setDate(d.getDate() - PRIORITY_LOOKBACK_DAYS);
    return formatDateOnly(d);
  }

  /** Fenêtre stades sommeil = j 8–{intraday} (pas toute l'année). */
  function historicalStagesDayFromStr() {
    const d = new Date();
    d.setDate(d.getDate() - SAMPLE_INTRADAY_LOOKBACK_DAYS);
    return formatDateOnly(d);
  }

  function isHistoricalDay(dayStr, dayFromStr, cutoffStr) {
    if (!dayStr || !dayFromStr || !cutoffStr) return false;
    return dayStr >= dayFromStr && dayStr < cutoffStr;
  }

  function isSyntheticSleepSample(item) {
    const pid = String(item?.platform_id ?? item?.platformId ?? "");
    if (SYNTHETIC_SLEEP_PLATFORM_RE.test(pid)) return true;
    const stage = item?.extra?.stage;
    if (stage == null || stage === "" || stage === "night") return true;
    return false;
  }

  function sleepSampleStage(item) {
    if (!item) return "";
    const extraStage = item.extra?.stage;
    if (extraStage != null && String(extraStage).trim()) return String(extraStage).trim();
    if (item.stage != null && String(item.stage).trim()) return String(item.stage).trim();
    return "";
  }

  function isHistCompactStagedSleepSample(item) {
    const pid = String(item?.platform_id ?? item?.platformId ?? "");
    if (!HIST_COMPACT_SLEEP_PLATFORM_RE.test(pid)) return false;
    const stage = sleepSampleStage(item);
    return stage.length > 0 && stage !== "night";
  }

  function isRealStagedSleepSample(item) {
    if (!item) return false;
    const dtype = item.data_type ?? item.dataType;
    if (dtype !== "sleep") return false;
    if (isSyntheticSleepSample(item)) return false;
    if (isHistCompactStagedSleepSample(item)) return true;
    const stage = sleepSampleStage(item);
    return stage.length > 0 && stage !== "night";
  }

  function wakeDayFromSleepSample(item) {
    return localDayKeyFromIso(item?.end_at ?? item?.endAt ?? item?.endDate);
  }

  function countHistoricalSleepNightsFromDaily(rows, dayFromStr, cutoffStr) {
    let count = 0;
    for (const row of rows ?? []) {
      const day = row?.day;
      if (!isHistoricalDay(day, dayFromStr, cutoffStr)) continue;
      if (Number(row.sleep_total_min) > 0) count += 1;
    }
    return count;
  }

  function listHistoricalNightsWithSleep(rows, dayFromStr, cutoffStr) {
    const nights = new Set();
    for (const row of rows ?? []) {
      const day = row?.day;
      if (!isHistoricalDay(day, dayFromStr, cutoffStr)) continue;
      if (Number(row.sleep_total_min) > 0) nights.add(day);
    }
    return [...nights].sort();
  }

  function evaluateSleepStagesCoverage(rows, sleepSamples, dayFromStr) {
    const cutoffStr = historicalCutoffDayStr();
    const historicalSleepNights = countHistoricalSleepNightsFromDaily(rows, dayFromStr, cutoffStr);
    const stagedNights = new Set();
    let syntheticHistorical = 0;

    for (const item of sleepSamples ?? []) {
      const wakeDay = wakeDayFromSleepSample(item);
      if (!isHistoricalDay(wakeDay, dayFromStr, cutoffStr)) continue;
      if (isRealStagedSleepSample(item)) {
        stagedNights.add(wakeDay);
      } else if (isSyntheticSleepSample(item) || item.data_type === "sleep" || item.dataType === "sleep") {
        syntheticHistorical += 1;
      }
    }

    const stagedCount = stagedNights.size;
    const nightsWithSleep = listHistoricalNightsWithSleep(rows, dayFromStr, cutoffStr);
    const missingWakeDays = nightsWithSleep.filter((day) => !stagedNights.has(day));
    const needsRepair =
      historicalSleepNights >= MIN_HISTORICAL_SLEEP_NIGHTS_TO_REQUIRE &&
      stagedCount < MIN_HISTORICAL_STAGED_NIGHTS &&
      stagedCount < Math.ceil(historicalSleepNights * 0.7);

    return {
      sufficient: !needsRepair,
      reason: needsRepair ? "sleep_stages_insufficient" : "ok",
      historicalSleepNights,
      stagedHistoricalNights: stagedCount,
      missingWakeDays,
      missingWakeDayCount: missingWakeDays.length,
      syntheticHistoricalSamples: syntheticHistorical,
      historicalCutoff: cutoffStr,
      dayFrom: dayFromStr,
      needsSleepStagesRepair: needsRepair,
    };
  }

  async function fetchSleepSamplesForProbe(token, dayFromStr, options) {
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const maxPages =
      (options && options.sleepSampleMaxPages) || SLEEP_SAMPLES_PROBE_MAX_PAGES;
    const cutoffStr = (options && options.dateToStr) || historicalCutoffDayStr();
    const dateFrom = `${dayFromStr}T00:00:00.000Z`;
    const dateTo = `${cutoffStr}T23:59:59.999Z`;
    const items = [];

    for (let page = 1; page <= maxPages; page++) {
      const url =
        `/api/v1/patients/me/health/samples?data_type=sleep&date_from=${encodeURIComponent(dateFrom)}` +
        `&date_to=${encodeURIComponent(dateTo)}` +
        `&page=${page}&page_size=500&sort_order=desc`;
      const res = await fetch(url, { headers, cache: "no-store" });
      if (!res.ok) {
        return { items, httpStatus: res.status, truncated: true };
      }
      const body = await res.json();
      const pageItems = Array.isArray(body?.items) ? body.items : [];
      items.push(...pageItems);
      const totalPages = body?.total_pages ?? 1;
      if (pageItems.length < 500 || page >= totalPages) {
        return { items, httpStatus: res.status, truncated: false, total: body?.total ?? items.length };
      }
    }
    return { items, truncated: true, total: items.length };
  }

  async function probeServerSleepStagesCoverage(token, options) {
    if (!token) {
      return { sufficient: true, reason: "no_token", skipped: true };
    }

    const stagesDayFromStr = historicalStagesDayFromStr();
    const cutoffStr = historicalCutoffDayStr();

    let rows = options && options.rows;
    if (!Array.isArray(rows)) {
      const dailyProbe = await probeServerHistoricalCoverage(token, options);
      rows = dailyProbe.rows ?? [];
    }

    try {
      const sampleFetch = await fetchSleepSamplesForProbe(token, stagesDayFromStr, {
        ...(options || {}),
        dateToStr: cutoffStr,
      });
      if (sampleFetch.httpStatus && sampleFetch.httpStatus >= 400) {
        return {
          sufficient: true,
          reason: `samples_http_${sampleFetch.httpStatus}`,
          skipped: true,
          dayFrom: dayFromStr,
        };
      }
      const coverage = evaluateSleepStagesCoverage(rows, sampleFetch.items, stagesDayFromStr);
      return {
        ...coverage,
        sampleCount: sampleFetch.items.length,
        samplesTruncated: !!sampleFetch.truncated,
        totalSamples: sampleFetch.total ?? sampleFetch.items.length,
        stagesWindowFrom: stagesDayFromStr,
        stagesWindowTo: cutoffStr,
      };
    } catch (err) {
      return {
        sufficient: true,
        reason: String(err?.message ?? err).slice(0, 120) || "fetch_error",
        skipped: true,
        dayFrom: stagesDayFromStr,
      };
    }
  }

  /**
   * @param {object} storage — isFullBackfillComplete, isBackfillPending, setFullBackfillComplete, clearBackfillPending, log, sessionLog?
   */
  async function maybeSkipBackfillFromServer(storage, token, options) {
    const logFn = storage?.log || function () {};
    const sessionLog = storage?.sessionLog || logFn;

    if (!token) return { applied: false, reason: "no_token" };
    if (options && options.fullLookback) return { applied: false, reason: "force_full" };

    const localComplete =
      typeof storage?.isFullBackfillComplete === "function" && storage.isFullBackfillComplete();
    const pending =
      typeof storage?.isBackfillPending === "function" && storage.isBackfillPending();

    if (localComplete && !pending) {
      const sleepProbe = await probeServerSleepStagesCoverage(token, options);
      if (sleepProbe.needsSleepStagesRepair) {
        logFn(
          `Serveur: agrégats OK mais stades sommeil historiques insuffisants (${sleepProbe.stagedHistoricalNights ?? 0}/${sleepProbe.historicalSleepNights ?? 0} nuits j 8–${SAMPLE_INTRADAY_LOOKBACK_DAYS}) — réparation sommeil requise`,
        );
        sessionLog(
          `[sync-session] SLEEP_STAGES_GAP staged=${sleepProbe.stagedHistoricalNights} sleep_nights=${sleepProbe.historicalSleepNights}`,
        );
        return {
          applied: false,
          reason: "sleep_stages_insufficient",
          needsSleepStagesRepair: true,
          ...sleepProbe,
        };
      }
      return { applied: false, reason: "already_local" };
    }
    if (localComplete && pending) {
      if (typeof storage?.clearBackfillPending === "function") {
        storage.clearBackfillPending();
      }
      logFn("État sync : backfill terminé localement — pending obsolète effacé");
      return { applied: false, reason: "cleared_stale_pending" };
    }

    const lastLocalSync =
      typeof storage?.getLastDataSyncAt === "function" ? storage.getLastDataSyncAt() : 0;
    if (!lastLocalSync || lastLocalSync <= 0) {
      logFn(
        "Serveur: skip différé — aucune sync locale réussie sur cet appareil (backfill initial requis)",
      );
      return { applied: false, reason: "no_local_sync_yet" };
    }

    const probe = await probeServerHistoricalCoverage(token, options);
    const sleepProbe = await probeServerSleepStagesCoverage(token, {
      ...(options || {}),
      rows: probe.rows,
    });
    if (!probe.sufficient) {
      try {
        sessionStorage.removeItem("pcpHealthBackfillSkipMeta");
      } catch (_) {}
      logFn(
        `Serveur: couverture insuffisante (${probe.daysWithData ?? 0}j signal, ${probe.rowCount ?? 0} agrégats, span=${probe.spanDays ?? 0}j / fenêtre ${FULL_LOOKBACK_DAYS}j, oldest=${probe.oldestDay ?? "—"}) — backfill requis`,
      );
      return { applied: false, ...probe };
    }

    if (sleepProbe.needsSleepStagesRepair) {
      try {
        sessionStorage.removeItem("pcpHealthBackfillSkipMeta");
      } catch (_) {}
      logFn(
        `Serveur: couverture agrégats OK mais stades sommeil historiques insuffisants (${sleepProbe.stagedHistoricalNights ?? 0}/${sleepProbe.historicalSleepNights ?? 0} nuits) — pas de skip backfill, réparation sommeil`,
      );
      sessionLog(
        `[sync-session] SLEEP_STAGES_GAP staged=${sleepProbe.stagedHistoricalNights} sleep_nights=${sleepProbe.historicalSleepNights}`,
      );
      return {
        applied: false,
        reason: "sleep_stages_insufficient",
        needsSleepStagesRepair: true,
        ...probe,
        ...sleepProbe,
      };
    }

    const ts = Date.now();
    if (typeof storage?.setFullBackfillComplete === "function") {
      storage.setFullBackfillComplete(ts);
    }
    if (typeof storage?.clearBackfillPending === "function") {
      storage.clearBackfillPending();
    }

    const batchNote =
      probe.batchTotal != null && probe.batchTotal > 0 ? `, sync_batches=${probe.batchTotal}` : "";
    const sparseNote = probe.sparseProfile ? " profil-épars" : "";
    logFn(
      `Serveur: historique ~${FULL_LOOKBACK_DAYS}j déjà présent (${probe.daysWithData}j avec signal, ${probe.rowCount} agrégats, span=${probe.spanDays}j calendaires, oldest=${probe.oldestDay}${batchNote}${sparseNote}) — skip backfill 1 an, mode incrémental`,
    );
    sessionLog(
      `[sync-session] SERVER_BACKFILL_SKIP days=${probe.daysWithData} rows=${probe.rowCount} oldest=${probe.oldestDay} span=${probe.spanDays}${batchNote}${sparseNote}`,
    );

    try {
      sessionStorage.setItem(
        "pcpHealthBackfillSkipMeta",
        JSON.stringify({
          reason: "server_probe",
          at: ts,
          daysWithData: probe.daysWithData,
          rowCount: probe.rowCount,
          oldestDay: probe.oldestDay,
          spanDays: probe.spanDays,
          batchTotal: probe.batchTotal ?? null,
        }),
      );
    } catch (_) {}

    return { applied: true, ...probe };
  }

  window.PcpHealthServerBackfillProbe = {
    FULL_LOOKBACK_DAYS,
    SAMPLE_INTRADAY_LOOKBACK_DAYS,
    MIN_DAYS_WITH_SIGNAL,
    MIN_SPARSE_DAYS_WITH_SIGNAL,
    MIN_SPAN_DAYS,
    dailyRowHasSignal,
    dayRowMissingSteps,
    evaluateCoverage,
    evaluateStepsGaps,
    probeServerHistoricalCoverage,
    probeServerStepsGaps,
    probeServerSleepStagesCoverage,
    evaluateSleepStagesCoverage,
    isRealStagedSleepSample,
    historicalStagesDayFromStr,
    historicalCutoffDayStr,
    maybeSkipBackfillFromServer,
  };
})();
