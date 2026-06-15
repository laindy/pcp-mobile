/**
 * Agrégats journaliers à partir des samples HealthKit / Health Connect.
 * Le frontend patient lit GET /health/daily (steps_total, sleep_total_min, …).
 */
(function (global) {
  function localDayKey(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function numericValue(sample) {
    const v = sample?.value;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function intervalMinutes(sample) {
    const start = sample?.startDate ?? sample?.start_date;
    const end = sample?.endDate ?? sample?.end_date;
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return ms > 0 ? ms / 60000 : null;
  }

  /** Valeur métrique normalisée pour agrégats + stockage cohérent avec le frontend. */
  function metricValue(typeKey, sample) {
    let n = numericValue(sample);
    if (typeKey === "oxygenSaturation" && n != null && n > 0 && n <= 1) {
      n *= 100;
    }
    if ((n == null || n <= 0) && (typeKey === "mindfulness" || typeKey === "exerciseTime")) {
      n = intervalMinutes(sample);
    }
    return n;
  }

  function stageIntervalMinutes(stage) {
    let mins = Number(stage?.durationMinutes);
    if (Number.isFinite(mins) && mins > 0) return mins;
    const start = stage?.startDate ?? stage?.start_date;
    const end = stage?.endDate ?? stage?.end_date;
    if (start && end) {
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms > 0) return ms / 60000;
    }
    return null;
  }

  function sleepMinutes(sample) {
    // Contrat v1 : 1 segment = 1 sample avec champ stage top-level.
    if (sample?.stage != null && !Array.isArray(sample?.stages)) {
      const name = String(sample.stage).toLowerCase();
      if (name.includes("awake") || name.includes("inbed") || name.includes("in_bed") || name.includes("out_of_bed")) {
        return null;
      }
      const v = numericValue(sample);
      if (v != null && v > 0) return v;
      return intervalMinutes(sample);
    }
    const stages = sample?.stages;
    if (Array.isArray(stages) && stages.length > 0) {
      let fromStages = 0;
      for (const st of stages) {
        const name = String(st?.stage ?? st?.name ?? "").toLowerCase();
        if (name.includes("awake") || name.includes("inbed") || name.includes("in_bed")) continue;
        const mins = stageIntervalMinutes(st);
        if (mins != null && mins > 0) fromStages += mins;
      }
      if (fromStages > 0) return fromStages;
    }
    const v = numericValue(sample);
    if (v != null && v > 0) return v;
    return intervalMinutes(sample);
  }

  /** Nuit comptée sur le jour de réveil (fin de session). */
  function sleepDayKey(sample) {
    return localDayKey(sample?.endDate ?? sample?.end_date ?? sample?.startDate ?? sample?.start_date);
  }

  /**
   * @param {Record<string, { samples?: Array<Record<string, unknown>> }>} samplesByType
   * @returns {Array<Record<string, unknown>>}
   */
  function buildFromSamplesByType(samplesByType) {
    /** @type {Map<string, { sums: Record<string, number>, cal: { active?: number, total?: number }, avg: Record<string, { sum: number, count: number }> }>} */
    const days = new Map();

    function bucket(day) {
      if (!days.has(day)) {
        days.set(day, { sums: {}, cal: {}, avg: {} });
      }
      return days.get(day);
    }

    function addSum(day, key, n) {
      if (n == null || !Number.isFinite(n)) return;
      const b = bucket(day);
      b.sums[key] = (b.sums[key] || 0) + n;
    }

    function addAvg(day, key, n) {
      if (n == null || !Number.isFinite(n)) return;
      const b = bucket(day);
      if (!b.avg[key]) b.avg[key] = { sum: 0, count: 0 };
      b.avg[key].sum += n;
      b.avg[key].count += 1;
    }

    const avgFields = {
      restingHeartRate: "resting_heart_rate_avg",
      heartRateVariability: "hrv_avg_ms",
      respiratoryRate: "respiratory_rate_avg",
      oxygenSaturation: "oxygen_saturation_avg",
      bodyTemperature: "body_temperature_avg",
    };

    for (const typeKey of Object.keys(samplesByType || {})) {
      const samples = samplesByType[typeKey]?.samples;
      if (!Array.isArray(samples)) continue;

      for (const s of samples) {
        const day = localDayKey(s.startDate ?? s.start_date);
        if (!day) continue;

        if (typeKey === "sleep") {
          const mins = sleepMinutes(s);
          const sleepDay = sleepDayKey(s);
          if (mins != null && sleepDay) addSum(sleepDay, "sleep_total_min", mins);
          continue;
        }

        const n = typeKey === "sleep" ? null : metricValue(typeKey, s);
        if (n == null) continue;

        if (typeKey === "steps") {
          addSum(day, "steps_total", n);
        } else if (typeKey === "distance") {
          addSum(day, "distance_total_m", n);
        } else if (typeKey === "calories") {
          const b = bucket(day);
          b.cal.active = (b.cal.active || 0) + n;
        } else if (typeKey === "totalCalories") {
          const b = bucket(day);
          b.cal.total = (b.cal.total || 0) + n;
        } else if (typeKey === "mindfulness") {
          addSum(day, "mindfulness_total_min", n);
        } else if (typeKey === "exerciseTime") {
          addSum(day, "exercise_time_min", n);
        } else if (avgFields[typeKey]) {
          addAvg(day, avgFields[typeKey], n);
        }
      }
    }

    const out = [];
    for (const [day, b] of days) {
      const item = { day, primary_source: "healthkit" };
      let has = false;

      if (b.sums.steps_total != null && b.sums.steps_total > 0) {
        item.steps_total = Math.round(b.sums.steps_total);
        has = true;
      }
      if (b.sums.distance_total_m != null && b.sums.distance_total_m > 0) {
        item.distance_total_m = Math.round(b.sums.distance_total_m * 100) / 100;
        has = true;
      }
      const kcal =
        (b.cal.active != null && b.cal.active > 0 ? b.cal.active : null) ??
        (b.cal.total != null && b.cal.total > 0 ? b.cal.total : null);
      if (kcal != null) {
        item.calories_total_kcal = Math.round(kcal * 100) / 100;
        has = true;
      }
      if (b.sums.sleep_total_min != null && b.sums.sleep_total_min > 0) {
        item.sleep_total_min = Math.round(b.sums.sleep_total_min);
        has = true;
      }
      if (b.sums.mindfulness_total_min != null && b.sums.mindfulness_total_min > 0) {
        item.mindfulness_total_min = Math.round(b.sums.mindfulness_total_min);
        has = true;
      }
      if (b.sums.exercise_time_min != null && b.sums.exercise_time_min > 0) {
        item.extra = {
          ...(item.extra && typeof item.extra === "object" ? item.extra : {}),
          exercise_time_min: Math.round(b.sums.exercise_time_min),
        };
        has = true;
      }

      for (const [field, { sum, count }] of Object.entries(b.avg)) {
        if (count > 0) {
          item[field] = Math.round((sum / count) * 100) / 100;
          has = true;
        }
      }

      if (has) out.push(item);
    }

    out.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    return out;
  }

  global.PcpHealthDailyAggregates = { buildFromSamplesByType };
})(typeof window !== "undefined" ? window : globalThis);
