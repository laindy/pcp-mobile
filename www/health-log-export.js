/**
 * Buffer des logs [PcpHealth] + export pour testeurs (iOS / Android).
 * Partage via UIActivityViewController (iOS) ou Intent Android (Mail, Drive…).
 */
(function (global) {
  const MAX_LINES = 2500;
  const lines = [];

  function push(line) {
    const row = String(line);
    lines.push(row);
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
    }
  }

  function appendAndroidHealthConnectMeta(parts) {
    const bridge = global.PcpHealthBridge;
    if (!bridge) {
      parts.push("PcpHealthBridge: absent");
      return;
    }
    try {
      const hcStatus = bridge.peekHealthConnectStatus ? bridge.peekHealthConnectStatus() : -1;
      const statusLabel =
        hcStatus === 0
          ? "disponible"
          : hcStatus === 1
            ? "mise à jour requise"
            : hcStatus === 2
              ? "non installé"
              : "indisponible";
      parts.push(`Health Connect: ${statusLabel} (code ${hcStatus})`);
    } catch (e) {
      parts.push(`Health Connect: erreur ${e}`);
    }
    try {
      const granted = bridge.getHealthConnectGrantedCount
        ? bridge.getHealthConnectGrantedCount() | 0
        : 0;
      parts.push(`Permissions HC accordées (types worker): ${granted}`);
    } catch (e) {
      parts.push(`Permissions HC: erreur ${e}`);
    }
    try {
      const stepsOk = bridge.hasStepsReadPermission ? bridge.hasStepsReadPermission() : null;
      parts.push(
        `Permission lecture Pas (PCPTherapy): ${stepsOk === true ? "oui" : stepsOk === false ? "non" : "?"}`,
      );
    } catch (e) {
      parts.push(`Permission Pas: erreur ${e}`);
    }
    try {
      const info = JSON.parse(bridge.getLastSyncInfo ? bridge.getLastSyncInfo() || "{}" : "{}");
      parts.push(`Token natif: ${info.hasToken ? "oui" : "non"}`);
      parts.push(`API base: ${info.apiBase || "—"}`);
      parts.push(`Dernier outcome: ${info.lastOutcome || "—"}`);
      if (info.lastMessage) parts.push(`Dernier message: ${info.lastMessage}`);
      parts.push(
        `Dernière sync OK: ${info.lastSyncAt ? new Date(info.lastSyncAt).toISOString() : "jamais"}`,
      );
      parts.push(`Inserts: samples=${info.lastInserted ?? 0} aggregates=${info.lastAggregatesInserted ?? 0}`);
    } catch (e) {
      parts.push(`Sync natif: erreur ${e}`);
    }
  }

  function appendReportFooter(parts) {
    try {
      const getter = window.PcpHealthSyncStorage?.getItem;
      const syncKey = window.PcpHealthSyncStorage?.LAST_DATA_SYNC_KEY || "pcpHealthLastDataSyncAt";
      const lastAt = getter ? getter(syncKey) : sessionStorage.getItem("pcpHealthLastDataSyncAt");
      const patientScope = window.__pcpHealthSyncPatientId || sessionStorage.getItem("pcpHealthSyncScopePatientId");
      if (patientScope) parts.push(`Compte sync (patient id): ${patientScope}`);
      const summary = sessionStorage.getItem("pcpHealthLastSyncSummary");
      const sessionMeta = sessionStorage.getItem("pcpHealthSyncSessionMeta");
      parts.push(`Dernière sync données (session): ${lastAt ? new Date(parseInt(lastAt, 10)).toISOString() : "jamais"}`);
      if (summary) parts.push(`Résumé dernière sync: ${summary}`);
      if (sessionMeta) parts.push(`Dernière session sync: ${sessionMeta}`);
      const storage = window.PcpHealthSyncStorage;
      const pid = patientScope || "";
      const fullKey = storage?.FULL_BACKFILL_KEY || "pcpHealthFullBackfillAt";
      const pendingKey = storage?.BACKFILL_PENDING_KEY || "pcpHealthBackfillPending";
      const fullAt = storage?.getItem ? storage.getItem(fullKey) : sessionStorage.getItem(pid ? `${fullKey}:${pid}` : fullKey);
      const pending = storage?.getItem ? storage.getItem(pendingKey) : sessionStorage.getItem(pid ? `${pendingKey}:${pid}` : pendingKey);
      const backfillRunning = window.__pcpHealthBackfillRunning === true;
      const bannerVisible = window.__pcpBackfillBannerVisible === true;
      parts.push(
        `État backfill 1 an: running=${backfillRunning} pending=${pending === "1" ? "oui" : "non"} fullBackfillAt=${fullAt ? new Date(parseInt(fullAt, 10)).toISOString() : "—"} bandeau=${bannerVisible ? "visible" : "masqué"}`,
      );
      try {
        const skipMetaRaw = sessionStorage.getItem("pcpHealthBackfillSkipMeta");
        if (skipMetaRaw) {
          const skip = JSON.parse(skipMetaRaw);
          if (skip?.reason === "server_probe") {
            const batchNote =
              skip.batchTotal != null && skip.batchTotal > 0 ? ` batches=${skip.batchTotal}` : "";
            parts.push(
              `backfillSkippedReason=server_probe days=${skip.daysWithData ?? "—"} rows=${skip.rowCount ?? "—"} oldest=${skip.oldestDay ?? "—"} span=${skip.spanDays ?? "—"}${batchNote} at=${skip.at ? new Date(skip.at).toISOString() : "—"}`,
            );
          }
        }
      } catch (_) {}
      try {
        const stepsRepairKey = storage?.STEPS_REPAIR_KEY || "pcpHealthStepsRepairV2";
        const stepsRepairAt = storage?.getItem
          ? storage.getItem(stepsRepairKey)
          : sessionStorage.getItem(pid ? `${stepsRepairKey}:${pid}` : stepsRepairKey);
        parts.push(
          `Réparation pas 1 an (1×): ${stepsRepairAt ? `effectuée ${new Date(parseInt(stepsRepairAt, 10)).toISOString()}` : "en attente si jours sans steps_total"}`,
        );
      } catch (_) {}
      try {
        const activityRepairKey =
          storage?.ACTIVITY_CALORIES_REPAIR_KEY || "pcpHealthActivityCaloriesRepairV1";
        const activityRepairAt = storage?.getItem
          ? storage.getItem(activityRepairKey)
          : sessionStorage.getItem(pid ? `${activityRepairKey}:${pid}` : activityRepairKey);
        const repairDays = global.PcpHealthSyncConstants?.RECENT_ACTIVITY_REPAIR_DAYS ?? 14;
        parts.push(
          `Réparation énergie/effort ${repairDays}j (1×): ${activityRepairAt ? `effectuée ${new Date(parseInt(activityRepairAt, 10)).toISOString()}` : "en attente si kcal/effort récents manquants"}`,
        );
      } catch (_) {}
      try {
        const intradayDays =
          global.PcpHealthSyncConstants?.SAMPLE_INTRADAY_LOOKBACK_DAYS ?? 90;
        const sleepStagesKey = storage?.SLEEP_STAGES_REPAIR_KEY || "pcpHealthSleepStagesRepairV2";
        const sleepStagesAt = storage?.getItem
          ? storage.getItem(sleepStagesKey)
          : sessionStorage.getItem(pid ? `${sleepStagesKey}:${pid}` : sleepStagesKey);
        parts.push(
          `Réparation stades sommeil j 8–${intradayDays}: ${sleepStagesAt ? `effectuée ${new Date(parseInt(sleepStagesAt, 10)).toISOString()}` : "en attente si stades historiques insuffisants"}`,
        );
      } catch (_) {}
      try {
        const intradayDays =
          global.PcpHealthSyncConstants?.SAMPLE_INTRADAY_LOOKBACK_DAYS ?? 90;
        const dailyRepairKey =
          storage?.DAILY_EXTENDED_SLEEP_WORKOUT_REPAIR_KEY || "pcpHealthDailyExtendedSleepWorkoutRepairV2";
        const dailyRepairAt = storage?.getItem
          ? storage.getItem(dailyRepairKey)
          : sessionStorage.getItem(pid ? `${dailyRepairKey}:${pid}` : dailyRepairKey);
        parts.push(
          `Réparation sommeil+workouts j ${intradayDays + 1}–365: ${
            dailyRepairAt
              ? `effectuée ${new Date(parseInt(dailyRepairAt, 10)).toISOString()}`
              : fullAt
                ? "non requise (backfill initial récent)"
                : "en attente si backfill 1 an déjà fait"
          }`,
        );
      } catch (_) {}
      try {
        const prevIntraday =
          global.PcpHealthSyncConstants?.PREVIOUS_INTRADAY_LOOKBACK_DAYS ?? 60;
        const intradayDays =
          global.PcpHealthSyncConstants?.SAMPLE_INTRADAY_LOOKBACK_DAYS ?? 90;
        const scoringRepairKey =
          storage?.SCORING_90D_REPAIR_KEY || "pcpHealthScoring90dRepairV1";
        const scoringRepairAt = storage?.getItem
          ? storage.getItem(scoringRepairKey)
          : sessionStorage.getItem(pid ? `${scoringRepairKey}:${pid}` : scoringRepairKey);
        parts.push(
          `Réparation intraday scoring j ${prevIntraday + 1}–${intradayDays} (1×): ${
            scoringRepairAt
              ? `effectuée ${new Date(parseInt(scoringRepairAt, 10)).toISOString()}`
              : fullAt
                ? "en attente si backfill terminé avant migration 90j"
                : "—"
          }`,
        );
      } catch (_) {}
      try {
        const priorityDays = global.PcpHealthSyncConstants?.PRIORITY_LOOKBACK_DAYS ?? 7;
        const intradayDays =
          global.PcpHealthSyncConstants?.SAMPLE_INTRADAY_LOOKBACK_DAYS ?? 90;
        const recoveryRepairKey =
          storage?.RECOVERY_RESCORE_REPAIR_KEY || "pcpHealthRecoveryRescoreRepairV4";
        const recoveryRepairAt = storage?.getItem
          ? storage.getItem(recoveryRepairKey)
          : sessionStorage.getItem(pid ? `${recoveryRepairKey}:${pid}` : recoveryRepairKey);
        parts.push(
          `Réparation recovery rescoring j ${priorityDays + 1}–${intradayDays} (1×): ${
            recoveryRepairAt
              ? `effectuée ${new Date(parseInt(recoveryRepairAt, 10)).toISOString()}`
              : fullAt
                ? "en attente (prochaine sync)"
                : "—"
          }`,
        );
      } catch (_) {}
      try {
        const planMetaRaw = sessionStorage.getItem("pcpHealthSyncPlanMeta");
        if (planMetaRaw) {
          const pm = JSON.parse(planMetaRaw);
          if (pm?.mode === "incremental" && pm.incrementalWindowDays != null) {
            const gap =
              pm.incrementalGapHours != null ? ` gap=${pm.incrementalGapHours}h` : "";
            const mode = pm.incrementalExtendedByGap
              ? `étendue (dernière sync − 24 h overlap)${gap}`
              : `plancher 48 h${gap}`;
            const compactNote = pm.incrementalCompact ? " | vitaux/sommeil compact (1 pt/jour)" : "";
            parts.push(
              `Fenêtre incrémentale: ${pm.incrementalWindowDays}j — ${mode} — pas de trou si absence sync courte${compactNote}`,
            );
          }
        }
      } catch (_) {}
    } catch (_) {}

    parts.push("");
    parts.push("--- Champs attendus frontend (GET /health/daily, limit=1) ---");
    parts.push("steps_total, distance_total_m, calories_total_kcal, sleep_total_min");
    parts.push("hrv_avg_ms, resting_heart_rate_avg, respiratory_rate_avg, oxygen_saturation_avg");
    parts.push("recovery_score, sleep_score, stress_score, effort_score");
    parts.push("");
    parts.push("--- Champs attendus frontend (GET /health/vitals/latest) ---");
    parts.push("hrv, resting_heart_rate, respiratory_rate, oxygen_saturation, body_temperature");
    parts.push("");
    parts.push("--- Instructions testeur ---");
    parts.push("1. Sync manuelle (glisser gauche sur Accueil patient)");
    parts.push("2. Le bouton « Envoyer les logs » reste visible pendant toute la sync");
    parts.push("3. Il disparaît ~4s après avoir changé de page dans l'app");
    parts.push("4. Chercher [sync-session] et ERREUR SERVEUR HTTP 500 si sync longue ou échec");
    parts.push("5. Envoyer ce fichier à l'équipe PCP (Mail / Drive / Messages)");
    parts.push("");
    parts.push(`--- Journal (${lines.length} lignes) ---`);
    if (lines.length === 0) {
      parts.push("(vide — lancez une sync puis réessayez)");
    } else {
      parts.push(...lines);
    }
  }

  function buildReportHeader(parts, platform) {
    parts.push("=== PCP Health Sync — rapport testeur ===");
    parts.push(`Généré: ${new Date().toISOString()}`);
    parts.push(`App: com.pcpinnov.patient`);
    parts.push(`Plateforme: ${platform}`);
    parts.push(`OS: ${global.__pcpOsVersion ?? "unknown"}`);
    parts.push(`Page: ${global.location?.pathname ?? ""}`);

    try {
      const ua = String(global.navigator?.userAgent ?? "").slice(0, 200);
      if (ua) parts.push(`UA: ${ua}`);
    } catch (_) {}
  }

  /** Version synchrone — utilisée par le natif Android via evaluateJavascript (sans appels bridge). */
  function buildReportSync() {
    const parts = [];
    const platform = global.Capacitor?.getPlatform?.() ?? "unknown";
    buildReportHeader(parts, platform);
    appendReportFooter(parts);
    return parts.join("\n");
  }

  async function buildReport() {
    const parts = [];
    const platform = global.Capacitor?.getPlatform?.() ?? "unknown";
    buildReportHeader(parts, platform);

    if (platform === "android") {
      parts.push("");
      parts.push("--- Health Connect (Android) ---");
      appendAndroidHealthConnectMeta(parts);
    } else {
      try {
        const Health = global.Capacitor?.Plugins?.Health;
        if (Health?.getPluginVersion) {
          const v = await Health.getPluginVersion();
          parts.push(`Plugin @capgo/capacitor-health: ${v?.version ?? "unknown"}`);
        }
        if (Health?.isAvailable) {
          const avail = await Health.isAvailable();
          parts.push(`HealthKit disponible: ${avail?.available ? "oui" : "non"} (${avail?.reason ?? ""})`);
        }
        if (Health?.checkAuthorization) {
          const readTypes = [
            "steps",
            "distance",
            "calories",
            "heartRate",
            "weight",
            "sleep",
            "respiratoryRate",
            "oxygenSaturation",
            "restingHeartRate",
            "heartRateVariability",
            "bodyTemperature",
            "workouts",
          ];
          const st = await Health.checkAuthorization({ read: readTypes, write: [] });
          const granted = Array.isArray(st?.readAuthorized) ? st.readAuthorized : [];
          const denied = Array.isArray(st?.readDenied) ? st.readDenied : [];
          parts.push(`Autorisé Capgo (${granted.length}): ${granted.join(", ") || "—"}`);
          parts.push(`Refusé Capgo: ${denied.join(", ") || "—"}`);
        }
      } catch (err) {
        parts.push(`Meta HealthKit: ${err}`);
      }
    }

    appendReportFooter(parts);
    return parts.join("\n");
  }

  async function share() {
    if (
      global.webkit &&
      global.webkit.messageHandlers &&
      global.webkit.messageHandlers.pcpHealthShareLogs
    ) {
      const report = await buildReport();
      global.webkit.messageHandlers.pcpHealthShareLogs.postMessage(report);
      return { ok: true, method: "native-ios" };
    }
    const bridge = global.PcpHealthBridge;
    if (bridge?.requestShareSyncLogs) {
      try {
        bridge.requestShareSyncLogs();
        return { ok: true, method: "native-android", pending: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    if (bridge?.shareSyncLogs) {
      try {
        const report = await buildReport();
        bridge.shareSyncLogs(report);
        return { ok: true, method: "native-android-legacy" };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    try {
      const report = await buildReport();
      if (global.navigator?.clipboard?.writeText) {
        await global.navigator.clipboard.writeText(report);
        return { ok: true, method: "clipboard" };
      }
      return { ok: false, report };
    } catch (_) {
      return { ok: false };
    }
  }

  global.PcpHealthLogExport = {
    push,
    buildReport,
    buildReportSync,
    share,
    getLineCount: () => lines.length,
  };
})(window);
