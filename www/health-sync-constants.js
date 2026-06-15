/**
 * Fenêtres de sync santé — source unique iOS / Android (WebView) / probe serveur.
 *
 * - Agrégats journaliers + workouts : 1 an (graphs longue période).
 * - Samples intraday scoring (vitaux, sommeil stades, FC séance) : 90 j
 *   (aligné LOAD_REF_WINDOW_DAYS backend — Effort / Récupération / charge).
 * - Phase récente prioritaire : 7 j (UI rapide).
 */
(function () {
  if (window.PcpHealthSyncConstants) return;

  var DAILY_AGGREGATE_LOOKBACK_DAYS = 365;
  var SAMPLE_INTRADAY_LOOKBACK_DAYS = 90;
  /** Ancienne fenêtre intraday — gap j 61–90 pour réparation 1× après migration. */
  var PREVIOUS_INTRADAY_LOOKBACK_DAYS = 60;
  var PRIORITY_LOOKBACK_DAYS = 7;
  var WORKOUT_LOOKBACK_DAYS = 365;

  /** Probe serveur — couverture agrégats journaliers sur 1 an. */
  var MIN_DAYS_WITH_SIGNAL = 210;
  var MIN_SPARSE_DAYS_WITH_SIGNAL = 14;
  var MIN_SPAN_DAYS = 330;
  var OLDEST_SLACK_DAYS = 14;

  var SAMPLE_HISTORICAL_SLICE_DAYS = 10;
  var DAILY_EXTENDED_SLICE_DAYS = 30;

  window.PcpHealthSyncConstants = {
    DAILY_AGGREGATE_LOOKBACK_DAYS: DAILY_AGGREGATE_LOOKBACK_DAYS,
    SAMPLE_INTRADAY_LOOKBACK_DAYS: SAMPLE_INTRADAY_LOOKBACK_DAYS,
    PREVIOUS_INTRADAY_LOOKBACK_DAYS: PREVIOUS_INTRADAY_LOOKBACK_DAYS,
    PRIORITY_LOOKBACK_DAYS: PRIORITY_LOOKBACK_DAYS,
    WORKOUT_LOOKBACK_DAYS: WORKOUT_LOOKBACK_DAYS,
    /** Alias probe / logs « backfill journalier ». */
    FULL_LOOKBACK_DAYS: DAILY_AGGREGATE_LOOKBACK_DAYS,
    MIN_DAYS_WITH_SIGNAL: MIN_DAYS_WITH_SIGNAL,
    MIN_SPARSE_DAYS_WITH_SIGNAL: MIN_SPARSE_DAYS_WITH_SIGNAL,
    MIN_SPAN_DAYS: MIN_SPAN_DAYS,
    OLDEST_SLACK_DAYS: OLDEST_SLACK_DAYS,
    SAMPLE_HISTORICAL_SLICE_DAYS: SAMPLE_HISTORICAL_SLICE_DAYS,
    DAILY_EXTENDED_SLICE_DAYS: DAILY_EXTENDED_SLICE_DAYS,
  };
})();
