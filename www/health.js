/**
 * Panneau de contrôle debug pour la sync santé native.
 *
 * Cette page NE LIT PLUS Health Connect en JS (capgo readSamples) — c'est le
 * WorkManager Kotlin qui s'en charge en background via aggregate() + readRecords(),
 * pour éviter tout rate-limit foreground.
 *
 * Ici on se limite à :
 *  - vérifier / demander les permissions HC via le plugin capgo
 *    (checkAuthorization / requestAuthorization ne comptent PAS dans le quota
 *    de lecture, donc safe à appeler à volonté),
 *  - exposer un bouton "Déclencher la sync maintenant" qui appelle
 *    window.PcpHealthBridge.triggerSync() (lance un WorkManager one-shot),
 *  - afficher le dernier état du worker (succès / erreur / nb de samples).
 */

/**
 * Types Capgo iOS + repli natif pour vo2Max (PcpHealthKitVo2Max si Capgo échoue).
 */
const IOS_READ_TYPES = [
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
  "bloodPressure",
  "bloodGlucose",
  "bodyTemperature",
  "height",
  "flightsClimbed",
  "exerciseTime",
  "distanceCycling",
  "bodyFat",
  "basalBodyTemperature",
  "basalCalories",
  "totalCalories",
  "mindfulness",
  "workouts",
];
/** Capgo iOS : vo2Max absent (plugin unsupported) — auth + lecture via natif Swift. */

/** Types supplémentaires Health Connect (Android uniquement dans capgo 8.6). */
const ANDROID_ONLY_READ_TYPES = [];

function readTypesForPlatform(platform) {
  if (platform === "ios") return IOS_READ_TYPES;
  return [...IOS_READ_TYPES.filter((t) => t !== "workouts"), ...ANDROID_ONLY_READ_TYPES, "workouts"];
}

function sampleTypesForSync(platform) {
  return readTypesForPlatform(platform).filter((type) => type !== "workouts");
}
const SYNC_ENDPOINT = "/api/v1/patients/me/health/sync";
const IOS_LOOKBACK_DAYS =
  (window.PcpHealthSyncConstants && window.PcpHealthSyncConstants.DAILY_AGGREGATE_LOOKBACK_DAYS) || 365;
const IOS_SAMPLE_LIMIT = 500;

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  btnRequest: document.getElementById("btn-request"),
  debug: document.getElementById("debug"),
  backendStatus: document.getElementById("backend-status"),
  backendStatusText: document.getElementById("backend-status-text"),
  apiBase: document.getElementById("api-base"),
  btnSaveBase: document.getElementById("btn-save-base"),
  // Champs login désactivés — voir health.html (capturé via SessionInterceptor en prod).
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  btnLogin: document.getElementById("btn-login"),
  btnSyncNow: document.getElementById("btn-sync-now"),
  btnClearToken: document.getElementById("btn-clear-token"),
  backendResult: document.getElementById("backend-result"),
  fetchButtons: document.getElementById("fetch-buttons"),
  fetchResult: document.getElementById("fetch-result"),
  fetchResultPretty: document.getElementById("fetch-result-pretty"),
};

const debugLines = [];
function log(line) {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  debugLines.push(`[${ts}] ${line}`);
  if (debugLines.length > 80) debugLines.shift();
  els.debug.textContent = debugLines.join("\n");
}

function setStatus(kind, message) {
  els.status.className = `status-card is-${kind}`;
  els.statusText.textContent = message;
}

function setBackendStatus(kind, message) {
  els.backendStatus.className = `status-card is-${kind}`;
  els.backendStatusText.textContent = message;
}

function formatDateTime(ms) {
  if (!ms || ms <= 0) return "jamais";
  try {
    return new Date(ms).toLocaleString("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    return String(ms);
  }
}

function loadPlugin() {
  const Capacitor = window.Capacitor;
  if (!Capacitor) {
    throw new Error("Cette page doit être ouverte dans l'app mobile (Capacitor non détecté).");
  }
  const platform = Capacitor.getPlatform?.() ?? "web";
  log(`Plateforme détectée : ${platform}`);
  if (platform === "web") {
    throw new Error("Le navigateur web ne supporte pas Health Connect — ouvre cette page dans l'app.");
  }
  const Health = Capacitor.Plugins?.Health;
  if (!Health) {
    throw new Error("Plugin Health introuvable. Vérifie @capgo/capacitor-health + cap sync.");
  }
  return { Health, platform };
}

// ─── Init ──────────────────────────────────────────────────────────────────

async function init() {
  setStatus("warning", "Chargement…");
  let Health;
  let platform = "web";
  try {
    ({ Health, platform } = loadPlugin());
  } catch (err) {
    setStatus("error", err?.message ?? String(err));
    log(`Erreur plugin : ${err?.message ?? err}`);
    return;
  }

  try {
    const availability = await Health.isAvailable();
    log(`isAvailable → ${JSON.stringify(availability)}`);
    if (!availability.available) {
      setStatus(
        "warning",
        availability.reason || "Health Connect indisponible (à installer depuis le Play Store).",
      );
      els.btnRequest.disabled = true;
      return;
    }
  } catch (err) {
    setStatus("error", `isAvailable a échoué : ${err?.message ?? err}`);
    return;
  }

  els.btnRequest.disabled = false;
  await checkAuth(Health);

  els.btnRequest.addEventListener("click", () => requestAuth(Health));
  initBackendSection(Health, platform);
}

async function checkAuth(Health) {
  const platform = window.Capacitor?.getPlatform?.() ?? "web";
  const types = readTypesForPlatform(platform);
  try {
    const status = await Health.checkAuthorization({ read: types, write: [] });
    log(`checkAuthorization → ${JSON.stringify(status)}`);
    const granted = (status.readAuthorized ?? []).length;
    if (granted === 0) {
      setStatus("warning", "Aucun type autorisé. Appuie sur le bouton ci-dessous.");
    } else if (granted < types.length) {
      setStatus("warning", `${granted}/${types.length} type(s) autorisé(s) — sync partielle possible.`);
    } else {
      setStatus("success", `Tous les types (${types.length}) sont autorisés.`);
    }
  } catch (err) {
    log(`checkAuthorization erreur : ${err?.message ?? err}`);
    setStatus("error", `Vérification permissions échouée : ${err?.message ?? err}`);
  }
}

async function requestAuth(Health) {
  const platform = window.Capacitor?.getPlatform?.() ?? "unknown";
  const types = readTypesForPlatform(platform);
  els.btnRequest.disabled = true;
  setStatus("warning", "Demande d'autorisation en cours…");
  try {
    const status = await Health.requestAuthorization({ read: types, write: [] });
    log(`requestAuthorization → ${JSON.stringify(status)}`);
    const granted = (status.readAuthorized ?? []).length;
    if (granted === 0) {
      const hint =
        platform === "ios"
          ? "Aucune permission iOS accordée. Vérifie Santé > Profil > Apps > PCPTherapy."
          : "Aucune autorisation accordée. Re-essaie depuis l'app Health Connect.";
      setStatus("error", hint);
    } else if (granted < types.length) {
      setStatus("warning", `${granted}/${types.length} type(s) autorisé(s).`);
    } else {
      setStatus("success", "Toutes les permissions ont été accordées.");
    }
  } catch (err) {
    setStatus("error", `Autorisation refusée : ${err?.message ?? err}`);
    log(`requestAuthorization erreur globale: ${stringifyError(err)}`);
  } finally {
    els.btnRequest.disabled = false;
  }
}

function stringifyError(err) {
  if (!err) return "unknown";
  try {
    if (typeof err === "string") return err;
    return JSON.stringify(err);
  } catch {
    return String(err?.message ?? err);
  }
}
// ─── Section sync native ───────────────────────────────────────────────────

function bridge() {
  return window.PcpHealthBridge ?? null;
}

function initBackendSection(Health, platform) {
  const b = bridge();
  const hasNativeBridge = !!b;
  const isIosFallback = platform === "ios" && !hasNativeBridge;
  const canUseNativeBridge = hasNativeBridge;
  if (!canUseNativeBridge && !isIosFallback) {
    setBackendStatus("error", "Bridge natif indisponible sur cette plateforme.");
    els.btnSyncNow.disabled = true;
    return;
  }

  if (canUseNativeBridge) {
    // Pré-remplit le champ API base depuis le natif.
    refreshBackendInfo();
  } else {
    setBackendStatus("warning", "iOS détecté: sync directe JS -> backend (pas de worker natif).");
    els.backendResult.textContent = [
      "Mode iOS direct",
      "Token: session NextAuth (/api/auth/session)",
      `Endpoint: ${SYNC_ENDPOINT}`,
      `Fenêtre: ${IOS_LOOKBACK_DAYS} jours`,
    ].join("\n");
  }

  els.btnSaveBase.addEventListener("click", () => {
    const v = els.apiBase.value.trim();
    if (v && canUseNativeBridge && b.setApiBase) {
      b.setApiBase(v);
      log(`setApiBase("${v}") envoyé au natif.`);
      refreshBackendInfo();
    }
  });

  els.btnSyncNow.addEventListener("click", async () => {
    if (isIosFallback) {
      await syncIosNow(Health);
      return;
    }
    if (!b?.triggerSync) {
      log("triggerSync non disponible sur le bridge.");
      return;
    }
    if (!b.hasToken || !b.hasToken()) {
      setBackendStatus(
        "error",
        "Pas de token enregistré — utilise le formulaire ci-dessous ou login via le frontend.",
      );
      return;
    }
    b.triggerSync();
    setBackendStatus("warning", "Sync one-shot programmée — recharge l'état dans quelques secondes.");
    log("triggerSync() → WorkManager one-shot programmé.");
    setTimeout(refreshBackendInfo, 4000);
    setTimeout(refreshBackendInfo, 10000);
  });

  els.btnClearToken.addEventListener("click", () => {
    if (canUseNativeBridge && b.clearToken) {
      b.clearToken();
      log("clearToken() → token effacé + sync périodique annulée.");
      refreshBackendInfo();
    }
  });

  // Listener login conditionnel — la section est commentée en prod.
  if (els.btnLogin) {
    els.btnLogin.addEventListener("click", handleLogin);
  }

  // Boutons "fetch backend" — délégation sur le conteneur.
  if (els.fetchButtons) {
    els.fetchButtons.addEventListener("click", (event) => {
      const target = event.target.closest("button[data-fetch]");
      if (!target) return;
      fetchBackendResource(target, {
        path: target.getAttribute("data-fetch"),
        view: target.getAttribute("data-view") || "json",
        label: target.getAttribute("data-label") || "",
      });
    });
  }

  if (canUseNativeBridge) {
    // Poll léger : tous les 3s tant que la page est visible.
    setInterval(() => {
      if (document.visibilityState === "visible") refreshBackendInfo();
    }, 3000);
  }
}

function fetchBackendResource(button, opts) {
  const { path, view, label } = opts;
  const b = bridge();
  if (!b || !b.fetchBackend) {
    els.fetchResult.textContent = "Bridge natif indisponible (mise à jour APK requise).";
    return;
  }
  if (!b.hasToken || !b.hasToken()) {
    els.fetchResult.textContent = "Pas de token enregistré — utilise le formulaire ci-dessus.";
    return;
  }
  const previousLabel = button.querySelector(".btn-label")?.textContent;
  button.disabled = true;
  if (previousLabel) button.querySelector(".btn-label").textContent = "Chargement…";
  els.fetchResultPretty.innerHTML = "";
  els.fetchResult.textContent = `GET ${path}\n…`;
  log(`GET ${path}`);

  setTimeout(() => {
    let raw;
    try {
      raw = b.fetchBackend(path);
    } catch (err) {
      els.fetchResult.textContent = `GET ${path}\nErreur bridge : ${err?.message ?? err}`;
      log(`fetchBackend exception : ${err?.message ?? err}`);
      restoreButton(button, previousLabel);
      return;
    }
    let wrapper;
    try {
      wrapper = JSON.parse(raw);
    } catch {
      els.fetchResult.textContent = `GET ${path}\nRéponse non JSON : ${raw}`;
      restoreButton(button, previousLabel);
      return;
    }
    if (wrapper.error) {
      els.fetchResult.textContent = `GET ${path}\nErreur : ${wrapper.error}`;
      log(`fetchBackend error : ${wrapper.error}`);
      restoreButton(button, previousLabel);
      return;
    }
    let body;
    try {
      body = JSON.parse(wrapper.body);
    } catch {
      body = wrapper.body;
    }
    const pretty = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    const summary = summarizeBody(body);
    els.fetchResult.textContent =
      `GET ${path}\nHTTP ${wrapper.status}${summary ? "  ·  " + summary : ""}\n\n${pretty}`;
    log(`GET ${path} → HTTP ${wrapper.status}${summary ? " · " + summary : ""}`);

    renderPretty(view, label, body, wrapper.status);
    restoreButton(button, previousLabel);
  }, 10);
}

function renderPretty(view, label, body, status) {
  const container = els.fetchResultPretty;
  container.innerHTML = "";
  if (status < 200 || status >= 300) return;

  if (view === "samples" && body && Array.isArray(body.items)) {
    container.appendChild(renderSamplesTable(label || "Samples", body.items));
    return;
  }
  if (view === "daily" && Array.isArray(body)) {
    container.appendChild(renderDailyTable(label || "Aggregates", body));
    return;
  }
}

function renderSamplesTable(title, items) {
  const wrap = document.createElement("div");
  const h = document.createElement("div");
  h.className = "data-section-title";
  h.textContent = `${title} · ${items.length} mesure(s)`;
  wrap.appendChild(h);

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "data-empty";
    empty.textContent = "Aucune mesure stockée côté backend.";
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Quand</th>
        <th>Valeur</th>
        <th>Source</th>
      </tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  items.forEach((s) => {
    const tr = document.createElement("tr");
    const when = formatDateTime(new Date(s.start_at).getTime());
    const value = `${formatSampleValue(s.value)} ${s.unit ?? ""}`;
    const source = s.source_name ?? s.source_id ?? "—";
    tr.innerHTML = `
      <td>${escapeHtml(when)}</td>
      <td class="num">${escapeHtml(value)}</td>
      <td>${escapeHtml(shortSource(source))}</td>`;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

function renderDailyTable(title, items) {
  const wrap = document.createElement("div");
  const h = document.createElement("div");
  h.className = "data-section-title";
  h.textContent = `${title} · ${items.length} jour(s)`;
  wrap.appendChild(h);

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "data-empty";
    empty.textContent = "Aucun jour agrégé côté backend.";
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Jour</th>
        <th>Pas</th>
        <th>Distance</th>
        <th>Calories</th>
      </tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  // Tri descendant par date — les plus récents en haut.
  const sorted = [...items].sort((a, b) => (a.day < b.day ? 1 : -1));
  sorted.forEach((d) => {
    const tr = document.createElement("tr");
    const steps = d.steps_total != null ? formatNumber(d.steps_total) : "—";
    const dist = d.distance_total_m != null ? `${(d.distance_total_m / 1000).toFixed(2)} km` : "—";
    const cal = d.calories_total_kcal != null ? `${formatNumber(parseFloat(d.calories_total_kcal))} kcal` : "—";
    tr.innerHTML = `
      <td>${escapeHtml(d.day)}</td>
      <td class="num">${escapeHtml(steps)}</td>
      <td class="num">${escapeHtml(dist)}</td>
      <td class="num">${escapeHtml(cal)}</td>`;
    tbody.appendChild(tr);
  });
  wrap.appendChild(table);
  return wrap;
}

function formatSampleValue(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString("fr-FR");
  return (Math.round(n * 100) / 100).toLocaleString("fr-FR");
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return Math.round(n).toLocaleString("fr-FR");
  return (Math.round(n * 10) / 10).toLocaleString("fr-FR");
}

function shortSource(src) {
  if (!src) return "—";
  // Raccourcit "com.google.android.apps.fitness" → "apps.fitness"
  const parts = String(src).split(".");
  if (parts.length <= 2) return src;
  return parts.slice(-2).join(".");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function restoreButton(button, previousLabel) {
  button.disabled = false;
  if (previousLabel) {
    const labelEl = button.querySelector(".btn-label");
    if (labelEl) labelEl.textContent = previousLabel;
  }
}

function summarizeBody(body) {
  if (!body || typeof body !== "object") return "";
  if (Array.isArray(body)) return `${body.length} élément(s)`;
  if (typeof body.total === "number" && Array.isArray(body.items)) {
    return `${body.items.length}/${body.total} item(s)`;
  }
  return "";
}

function refreshBackendInfo() {
  const b = bridge();
  if (!b || !b.getLastSyncInfo) return;
  let info = {};
  try {
    info = JSON.parse(b.getLastSyncInfo());
  } catch {
    info = {};
  }
  const lastSync = info.lastSyncAt || 0;
  const lastError = info.lastErrorAt || 0;
  const message = info.lastMessage || "—";
  const inserted = info.lastInserted || 0;
  const hasToken = !!info.hasToken;
  const apiBase = info.apiBase || "";

  if (!els.apiBase.value) els.apiBase.value = apiBase;

  const lines = [
    `Token       : ${hasToken ? "✓ enregistré" : "✗ absent"}`,
    `API base    : ${apiBase}`,
    `Dernière OK : ${formatDateTime(lastSync)} (${inserted} samples)`,
    `Dernier err.: ${formatDateTime(lastError)}`,
    `Message     : ${message}`,
  ];
  els.backendResult.textContent = lines.join("\n");

  if (!hasToken) {
    setBackendStatus("warning", "Pas de token — la sync est désactivée.");
  } else if (lastError > lastSync && lastError > 0) {
    setBackendStatus("error", message ?? "Dernière sync en erreur.");
  } else if (lastSync > 0) {
    setBackendStatus("success", `Dernière sync OK · ${formatDateTime(lastSync)}`);
  } else {
    setBackendStatus("warning", "Sync planifiée — en attente du premier run.");
  }
}

async function syncIosNow(Health) {
  els.btnSyncNow.disabled = true;
  setBackendStatus("warning", "Sync iOS en cours...");
  try {
    const token = await getSessionAccessToken();
    if (!token) {
      setBackendStatus("error", "Token NextAuth introuvable. Reconnecte-toi dans l'app.");
      return;
    }

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - IOS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const { payload, sentSamples, sentWorkouts } = await buildIosPayload(Health, startDate, endDate);
    const response = await fetch(SYNC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    if (!response.ok) {
      setBackendStatus("error", `Sync iOS refusée (${response.status})`);
      els.backendResult.textContent = JSON.stringify(body, null, 2);
      log(`POST ${SYNC_ENDPOINT} → HTTP ${response.status}`);
      return;
    }
    const inserted = body?.samples_inserted ?? 0;
    const skipped = body?.samples_skipped ?? 0;
    const aggInserted = body?.aggregates_inserted ?? 0;
    setBackendStatus("success", `Sync iOS OK (${sentSamples} samples, ${sentWorkouts} workouts).`);
    els.backendResult.textContent = JSON.stringify(body, null, 2);
    log(
      `Sync iOS OK: envoyés=${sentSamples} samples + ${sentWorkouts} workouts, inserts=${inserted}, skipped=${skipped}, aggregates=${aggInserted}`,
    );
  } catch (err) {
    setBackendStatus("error", `Sync iOS erreur: ${err?.message ?? err}`);
    log(`syncIosNow erreur: ${err?.message ?? err}`);
  } finally {
    els.btnSyncNow.disabled = false;
  }
}

async function getSessionAccessToken() {
  try {
    const res = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function buildIosPayload(Health, startDate, endDate) {
  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();
  const samplesByType = {};
  const readGranted = [];
  const readDenied = [];
  const errors = {};
  let totalSamples = 0;
  let workouts = [];

  for (const type of sampleTypesForSync("ios")) {
    try {
      const auth = await Health.checkAuthorization({ read: [type], write: [] });
      const authorized = Array.isArray(auth?.readAuthorized) && auth.readAuthorized.includes(type);
      if (!authorized) {
        readDenied.push(type);
        continue;
      }
      readGranted.push(type);
      const result = await Health.readSamples({
        dataType: type,
        startDate: startIso,
        endDate: endIso,
        limit: IOS_SAMPLE_LIMIT,
        ascending: false,
      });
      const rawSamples = Array.isArray(result?.samples) ? result.samples : [];
      const samples = rawSamples.map((s) => normalizeSample(type, s)).filter(Boolean);
      totalSamples += samples.length;
      samplesByType[type] = {
        // Backend contract: data_type stays canonical (same naming as Android payload).
        data_type: type,
        // iOS native identifier is kept separately for traceability/debugging.
        native_data_type: normalizeDataTypeId(type),
        unit_default: defaultUnitForType(type),
        sample_count: samples.length,
        samples,
      };
    } catch (err) {
      errors[type] = String(err?.message ?? err).slice(0, 500);
    }
  }

  if (typeof Health.queryWorkouts === "function") {
    try {
      const auth = await Health.checkAuthorization({ read: ["workouts"], write: [] });
      const workoutAuthorized =
        Array.isArray(auth?.readAuthorized) && auth.readAuthorized.includes("workouts");
      if (workoutAuthorized) {
        readGranted.push("workouts");
        const result = await Health.queryWorkouts({
          startDate: startIso,
          endDate: endIso,
          limit: IOS_SAMPLE_LIMIT,
          ascending: false,
        });
        workouts = (Array.isArray(result?.workouts) ? result.workouts : []).map((w) =>
          normalizeWorkout(w),
        ).filter((w) => w.startDate && w.endDate);
      } else {
        readDenied.push("workouts");
      }
    } catch (err) {
      errors.workouts = String(err?.message ?? err).slice(0, 500);
    }
  }

  const pluginVersion = await safeGetPluginVersion(Health);
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
        os_version: String(navigator.userAgent || "ios").slice(0, 50),
      },
      source: "healthkit",
      window: {
        start_date: startIso,
        end_date: endIso,
      },
      authorization: {
        read_granted: dedupeArray(readGranted),
        read_denied: dedupeArray(readDenied),
      },
      fetch: {
        strategy: "aggregate_plus_raw",
        limits: { per_type_sample_limit: IOS_SAMPLE_LIMIT },
        partial: Object.keys(errors).length > 0,
        errors,
      },
      samples_by_type: samplesByType,
      workouts: { items: workouts },
      daily_aggregates: [],
    },
    sentSamples: totalSamples,
    sentWorkouts: workouts.length,
  };
}

function normalizeSample(dataType, sample) {
  if (!sample || typeof sample !== "object") return null;
  const startDate = sample.startDate ?? sample.start_date ?? null;
  const endDate = sample.endDate ?? sample.end_date ?? startDate;
  const value = normalizeSampleValue(dataType, sample);
  const unit = sample.unit ?? defaultUnitForType(dataType) ?? null;
  const sourceName = sample.sourceName ?? sample.source_name ?? sample.sourceId ?? null;
  const sourceId = sample.sourceId ?? sample.source_id ?? null;
  const platformId =
    sample.platformId ??
    sample.id ??
    `${dataType}|${sourceId ?? sourceName ?? "unknown"}|${startDate ?? "na"}|${String(value).slice(0, 24)}`;
  const out = {
    dataType,
    value,
    unit,
    startDate,
    endDate,
    sourceId,
    sourceName,
    platformId: String(platformId).slice(0, 255),
  };
  if (dataType === "sleep" && Array.isArray(sample.stages)) {
    out.stages = sample.stages;
  }
  if (dataType === "bloodPressure") {
    const diastolic = toNumberOrNull(sample.diastolic ?? sample.diastolicValue);
    if (diastolic != null) out.diastolic = diastolic;
  }
  return out;
}

function normalizeWorkout(w) {
  const startDate = w?.startDate ?? null;
  const endDate = w?.endDate ?? null;
  const workoutType = w?.workoutType ?? w?.activityType ?? "unknown";
  const platformId = String(
    w?.platformId ?? w?.id ?? `workout|${workoutType}|${startDate ?? "na"}`,
  ).slice(0, 255);
  return {
    workoutType,
    duration: toIntOrNull(w?.duration),
    totalEnergyBurned: toNumberOrNull(w?.totalEnergyBurned),
    totalDistance: toNumberOrNull(w?.totalDistance),
    startDate,
    endDate,
    sourceId: w?.sourceId ?? w?.source_id ?? null,
    sourceName: w?.sourceName ?? w?.source_name ?? null,
    platformId,
  };
}

function sleepMinutesFromSample(sample) {
  const stages = sample?.stages;
  if (Array.isArray(stages) && stages.length > 0) {
    const fromStages = stages.reduce(
      (acc, st) => acc + (Number(st?.durationMinutes) || 0),
      0,
    );
    if (fromStages > 0) return fromStages;
  }
  const start = sample.startDate ?? sample.start_date;
  const end = sample.endDate ?? sample.end_date;
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms > 0) return ms / 60000;
  }
  const v = toNumberOrNull(sample.value);
  if (v != null && v > 10 && v < 24 * 60) return v;
  return null;
}

function normalizeSampleValue(dataType, sample) {
  if (dataType === "bloodPressure") {
    return toNumberOrNull(sample.systolic ?? sample.systolicValue);
  }
  if (dataType === "sleep") {
    return sleepMinutesFromSample(sample);
  }
  if (dataType === "oxygenSaturation") {
    const n = toNumberOrNull(sample.value);
    if (n != null && n > 0 && n <= 1) return n * 100;
    return n;
  }
  if (dataType === "audiogram") {
    return {
      frequencies: sample.frequencies ?? [],
      hearingLevels: sample.hearingLevels ?? sample.hearing_levels ?? [],
    };
  }
  return sample.value ?? null;
}

function normalizeDataTypeId(type) {
  const map = {
    steps: "HKQuantityTypeIdentifierStepCount",
    distance: "HKQuantityTypeIdentifierDistanceWalkingRunning",
    calories: "HKQuantityTypeIdentifierActiveEnergyBurned",
    heartRate: "HKQuantityTypeIdentifierHeartRate",
    weight: "HKQuantityTypeIdentifierBodyMass",
    sleep: "HKCategoryTypeIdentifierSleepAnalysis",
    respiratoryRate: "HKQuantityTypeIdentifierRespiratoryRate",
    oxygenSaturation: "HKQuantityTypeIdentifierOxygenSaturation",
    restingHeartRate: "HKQuantityTypeIdentifierRestingHeartRate",
    heartRateVariability: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    bloodPressure: "HKCorrelationTypeIdentifierBloodPressure",
    bloodGlucose: "HKQuantityTypeIdentifierBloodGlucose",
    bodyTemperature: "HKQuantityTypeIdentifierBodyTemperature",
    height: "HKQuantityTypeIdentifierHeight",
    flightsClimbed: "HKQuantityTypeIdentifierFlightsClimbed",
    vo2Max: "HKQuantityTypeIdentifierVO2Max",
    exerciseTime: "HKQuantityTypeIdentifierAppleExerciseTime",
    distanceCycling: "HKQuantityTypeIdentifierDistanceCycling",
    bodyFat: "HKQuantityTypeIdentifierBodyFatPercentage",
    basalBodyTemperature: "HKQuantityTypeIdentifierBasalBodyTemperature",
    basalCalories: "HKQuantityTypeIdentifierBasalEnergyBurned",
    totalCalories: "HKQuantityTypeIdentifierActiveEnergyBurned",
    mindfulness: "HKCategoryTypeIdentifierMindfulSession",
    workouts: "HKWorkoutTypeIdentifier",
  };
  return map[type] ?? type;
}

function defaultUnitForType(type) {
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
    vo2Max: "mL/min/kg",
    exerciseTime: "minute",
    distanceCycling: "meter",
    bodyFat: "percent",
    basalBodyTemperature: "celsius",
    basalCalories: "kilocalorie",
    totalCalories: "kilocalorie",
    mindfulness: "minute",
  };
  return map[type] ?? null;
}

async function safeGetPluginVersion(Health) {
  try {
    const version = await Health.getPluginVersion();
    return version?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function dedupeArray(values) {
  return [...new Set(values)];
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIntOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

async function handleLogin() {
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value;
  const base = (els.apiBase.value.trim() || "https://patient.pcpinnov.com").replace(/\/$/, "");
  const b = bridge();
  if (!email || !password) {
    setBackendStatus("error", "Email + mot de passe requis.");
    return;
  }
  if (!b) return;

  els.btnLogin.disabled = true;
  setBackendStatus("warning", "Connexion en cours…");
  try {
    const res = await fetch(`${base}/api/v1/auth/patient/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const bodyText = await res.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { raw: bodyText };
    }
    if (!res.ok) {
      setBackendStatus("error", `Login échec (${res.status}) : ${body?.detail ?? bodyText.slice(0, 120)}`);
      log(`login → HTTP ${res.status}`);
      return;
    }
    const token = body.access_token;
    if (!token) {
      setBackendStatus("error", "Réponse login sans access_token.");
      return;
    }
    if (b.setApiBase) b.setApiBase(base);
    b.setToken(token);
    els.loginPassword.value = "";
    log(`login OK → token transmis au bridge (${token.length} chars).`);
    setBackendStatus("success", "Token enregistré, sync périodique active + one-shot lancé.");
    setTimeout(refreshBackendInfo, 3000);
  } catch (err) {
    setBackendStatus("error", `Erreur réseau : ${err?.message ?? err}`);
  } finally {
    els.btnLogin.disabled = false;
  }
}

init().catch((err) => {
  setStatus("error", `Erreur init : ${err?.message ?? err}`);
  log(`init erreur : ${err?.message ?? err}`);
});
