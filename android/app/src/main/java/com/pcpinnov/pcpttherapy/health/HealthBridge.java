package com.pcpinnov.pcpttherapy.health;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import androidx.activity.result.ActivityResultLauncher;
import androidx.health.connect.client.HealthConnectClient;
import java.lang.ref.WeakReference;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONObject;

/**
 * JavaScript Interface exposée à la WebView principale sous le nom
 * {@code window.PcpHealthBridge}. C'est l'unique point d'entrée entre le
 * frontend Next.js (chargé sur https://patient.pcpinnov.com) et la couche
 * native santé.
 *
 * Contrat côté frontend :
 *
 * <pre>{@code
 * // après login NextAuth réussi :
 * if (window.PcpHealthBridge?.setToken) {
 *   window.PcpHealthBridge.setToken(session.accessToken);
 * }
 *
 * // au logout :
 * window.PcpHealthBridge?.clearToken();
 *
 * // déclenchement manuel (rare — la sync périodique 6h tourne déjà) :
 * window.PcpHealthBridge?.triggerSync();
 *
 * // lecture du dernier état de sync (page profil santé patient) :
 * const info = JSON.parse(window.PcpHealthBridge?.getLastSyncInfo() ?? '{}');
 * }</pre>
 *
 * Sécurité : seul le natif décide quand pousser au backend. Le frontend ne
 * voit jamais les données santé via ce bridge. Le token transite par cet
 * appel unique au login, puis est stocké chiffré côté natif (cf.
 * {@link TokenStore}).
 */
public class HealthBridge {

    public static final String JS_NAME = "PcpHealthBridge";
    private static final String TAG = "PcpHealthBridge";

    /** Instance WebView pour notifier le JS (backfill, etc.). */
    private static WeakReference<HealthBridge> jsNotifierRef;

    /** Package du provider Health Connect côté Play Store / système. */
    private static final String HC_PROVIDER_PACKAGE = "com.google.android.apps.healthdata";
    /** Deep link Play Store qui pré-cible l'onboarding HC après installation. */
    private static final String HC_PLAY_STORE_URI =
        "market://details?id=" + HC_PROVIDER_PACKAGE + "&url=healthconnect%3A%2F%2Fonboarding";
    /** Fallback web (devices sans app Play Store ou via WebView). */
    private static final String HC_PLAY_STORE_WEB_URI =
        "https://play.google.com/store/apps/details?id=" + HC_PROVIDER_PACKAGE
            + "&url=healthconnect%3A%2F%2Fonboarding";

    private final Context appContext;
    private final TokenStore store;
    private final WeakReference<Activity> activityRef;
    private final WeakReference<WebView> webViewRef;
    private OkHttpClient httpClient;

    private static final String PREFS_HC = "pcp_health_connect_prefs";
    private static final String KEY_INSTALL_DISMISSED_AT = "install_dismissed_at";
    private static final long INSTALL_DISMISS_COOLDOWN_MS = 24L * 60L * 60L * 1000L;

    private ActivityResultLauncher<Set<String>> hcPermissionLauncher;
    private WeakReference<AlertDialog> installDialogRef;
    private String pendingRationaleRequestId;

    public void attachPermissionLauncher(ActivityResultLauncher<Set<String>> launcher) {
        this.hcPermissionLauncher = launcher;
    }

    /** Appelé par MainActivity après l'écran permissions Health Connect. */
    public void onHealthConnectPermissionsResult(Set<String> granted) {
        int count = HealthConnectAuthHelper.countGrantedInSet(granted);
        Log.i(TAG, "Permissions HC accordées : " + count);
        String rid = pendingRationaleRequestId;
        pendingRationaleRequestId = null;
        if (rid != null) {
            resolvePermissionRationale(rid, count > 0);
        }
        if (count > 0) {
            notifyJsHealthAuthorized(count);
            store.reconcileBackfillState();
            Log.i(TAG, "Permissions HC accordées → sync foreground (backfill).");
            ForegroundHealthSync.enqueue(appContext);
        }
    }

    public HealthBridge(Activity activity) {
        this.appContext = activity.getApplicationContext();
        this.store = new TokenStore(appContext);
        this.activityRef = new WeakReference<>(activity);
        this.webViewRef = new WeakReference<>(null);
    }

    public HealthBridge(Activity activity, WebView webView) {
        this.appContext = activity.getApplicationContext();
        this.store = new TokenStore(appContext);
        this.activityRef = new WeakReference<>(activity);
        this.webViewRef = new WeakReference<>(webView);
        jsNotifierRef = new WeakReference<>(this);
    }

    /** Notifie la WebView qu'un backfill historique natif démarre. */
    public static void notifyJsBackfillStarted() {
        HealthBridge bridge = jsNotifierRef != null ? jsNotifierRef.get() : null;
        if (bridge != null) {
            bridge.dispatchJsCustomEvent("pcp-health-backfill-started", "{}");
        }
    }

    /** Pousse une ligne dans le journal testeur WebView (PcpHealthLogExport). */
    public static void logToJs(String message) {
        HealthBridge bridge = jsNotifierRef != null ? jsNotifierRef.get() : null;
        if (bridge == null || message == null || message.isEmpty()) {
            return;
        }
        WebView webView = bridge.webViewRef.get();
        Activity activity = bridge.activityRef.get();
        if (webView == null || activity == null) {
            return;
        }
        String safe;
        try {
            safe = org.json.JSONObject.quote("[Android] " + message);
        } catch (Exception e) {
            return;
        }
        String js = "(function(){try{"
            + "if(window.PcpHealthLogExport&&window.PcpHealthLogExport.push)"
            + "window.PcpHealthLogExport.push("
            + safe
            + ");"
            + "}catch(e){}})();";
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.w(TAG, "logToJs: " + t.getMessage());
            }
        });
    }

    /** Notifie la WebView qu'un backfill historique natif se termine. */
    public static void notifyJsBackfillFinished(boolean ok, String reason) {
        HealthBridge bridge = jsNotifierRef != null ? jsNotifierRef.get() : null;
        if (bridge == null) {
            return;
        }
        try {
            JSONObject detail = new JSONObject();
            detail.put("ok", ok);
            if (reason != null && !reason.isEmpty()) {
                detail.put("reason", reason);
            }
            bridge.dispatchJsCustomEvent("pcp-health-backfill-finished", detail.toString());
        } catch (Exception e) {
            bridge.dispatchJsCustomEvent(
                "pcp-health-backfill-finished",
                "{\"ok\":" + ok + "}"
            );
        }
    }

    private void dispatchJsCustomEvent(String eventName, String detailJson) {
        WebView webView = webViewRef.get();
        Activity activity = activityRef.get();
        if (webView == null || activity == null || eventName == null) {
            return;
        }
        String safeName = eventName.replaceAll("[^a-zA-Z0-9_-]", "");
        String detail = detailJson != null && !detailJson.isEmpty() ? detailJson : "{}";
        String js = "(function(){try{"
            + "window.dispatchEvent(new CustomEvent('"
            + safeName
            + "',{detail:"
            + detail
            + "}));"
            + "}catch(e){}})();";
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.w(TAG, "dispatchJsCustomEvent(" + safeName + "): " + t.getMessage());
            }
        });
    }

    private synchronized OkHttpClient http() {
        if (httpClient == null) {
            httpClient = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .build();
        }
        return httpClient;
    }

    /**
     * Stocke le JWT patient chiffré et démarre la sync périodique si pas déjà
     * planifiée. À appeler depuis le frontend après un login réussi.
     *
     * <p>Effet secondaire : si Health Connect n'est pas installé / pas à jour
     * sur le device (Android &lt; 14 typiquement), redirige automatiquement
     * l'utilisateur vers le Play Store via {@link #ensureHealthConnectInstalled()}.
     * Sans HC, la sync ne servirait à rien.</p>
     */
    /** Met à jour le JWT sans déclencher de sync (utilisé après refresh session). */
    @JavascriptInterface
    public void updateToken(String token) {
        if (token == null || token.trim().isEmpty()) {
            return;
        }
        store.setToken(token.trim());
    }

    @JavascriptInterface
    public void setToken(String token) {
        if (token == null || token.trim().isEmpty()) {
            Log.w(TAG, "setToken() appelé avec un token vide — ignoré.");
            return;
        }
        String trimmed = token.trim();
        String existing = store.getToken();
        boolean tokenChanged = existing == null || !existing.equals(trimmed);
        store.setToken(trimmed);
        Log.i(TAG, "JWT patient enregistré, planification de la sync périodique.");
        HealthSyncScheduler.INSTANCE.enqueuePeriodic(appContext);
        // Pas de sync WorkManager au login — aligné iOS : attendre les permissions HC,
        // puis ForegroundHealthSync via onHealthConnectPermissionsResult / hook JS.
        if (tokenChanged) {
            Log.i(TAG, "JWT modifié — sync différée jusqu'aux permissions Health Connect.");
        }
        // Install HC / permissions : uniquement depuis l'accueil patient (hook JS).
        dismissInstallDialogIfShowing();
    }

    /**
     * Efface le token et annule la sync périodique. À appeler au logout.
     */
    @JavascriptInterface
    public void clearToken() {
        store.clear();
        HealthSyncScheduler.INSTANCE.cancelPeriodic(appContext);
        Log.i(TAG, "Token effacé + sync périodique annulée.");
    }

    /**
     * Permet au frontend de surcharger l'URL de base (utile en preview /
     * staging). Défaut : https://patient.pcpinnov.com.
     */
    @JavascriptInterface
    public void setApiBase(String base) {
        store.setApiBase(base);
        Log.i(TAG, "API base mise à jour : " + base);
    }

    /** Déclenche une sync one-shot immédiate (réseau requis). */
    @JavascriptInterface
    public void triggerSync() {
        triggerSyncInternal(true);
    }

    /** Appel natif direct depuis le hook JS (évite d'écraser triggerSync côté WebView). */
    @JavascriptInterface
    public void enqueueHealthSync() {
        store.reconcileBackfillState();
        store.setSyncAttemptStarted(System.currentTimeMillis());
        try {
            ServerBackfillProbe.tryMarkComplete(store, http());
        } catch (Exception e) {
            Log.w(TAG, "Probe serveur backfill: " + e.getMessage());
        }
        store.reconcileBackfillState();
        triggerSyncInternal(false);
    }

    /** Timestamp ms du backfill 60 j marqué terminé (0 = pas encore). */
    @JavascriptInterface
    public long getFullBackfillAt() {
        return store.getFullBackfillAt();
    }

    /** Marque le backfill terminé (ex. après probe JS). */
    @JavascriptInterface
    public void markServerBackfillComplete(long epochMillis) {
        store.setFullBackfillComplete(epochMillis > 0L ? epochMillis : System.currentTimeMillis());
        store.reconcileBackfillState();
    }

    /** État sync scopé patient (survit au reload WebView). */
    @JavascriptInterface
    public String getSyncScopedState(String patientId) {
        if (patientId == null || patientId.trim().isEmpty()) {
            return "{}";
        }
        return HealthSyncStateStore.INSTANCE.getStateJson(appContext, patientId.trim());
    }

    @JavascriptInterface
    public void setSyncScopedState(String patientId, String key, String value) {
        if (patientId == null || patientId.trim().isEmpty() || key == null || key.trim().isEmpty()) {
            return;
        }
        HealthSyncStateStore.INSTANCE.setField(
            appContext,
            patientId.trim(),
            key.trim(),
            value == null ? "" : value
        );
    }

    @JavascriptInterface
    public boolean isBackfillRunning() {
        return HealthSyncExecutor.INSTANCE.isBackfillRunning();
    }

    @JavascriptInterface
    public boolean isBackfillPending() {
        return store.isBackfillPending();
    }

    /**
     * Sync manuelle / post-login : lecture HC au premier plan (requis par Google).
     * WorkManager reste réservé à la sync périodique 6h.
     */
    private void triggerSyncInternal(boolean forceFullLookback) {
        if (store.getToken() == null) {
            Log.w(TAG, "triggerSync() ignoré : pas de token stocké.");
            return;
        }
        ForegroundHealthSync.enqueue(appContext);
    }

    /** Indique si un token est actuellement stocké (sans le révéler). */
    @JavascriptInterface
    public boolean hasToken() {
        return store.getToken() != null;
    }

    /**
     * Lecture silencieuse du statut HC — ne déclenche aucune popup Play Store.
     * Même codes de retour que {@link #ensureHealthConnectInstalled()}.
     */
    @JavascriptInterface
    public int peekHealthConnectStatus() {
        int status = getHealthConnectSdkStatus();
        if (status == HealthConnectClient.SDK_AVAILABLE) {
            dismissInstallDialogIfShowing();
            return 0;
        }
        if (status == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
            return 1;
        }
        if (status == HealthConnectClient.SDK_UNAVAILABLE) {
            return 2;
        }
        return 3;
    }

    /** {@code true} si PCPTherapy peut lire les pas (distinct de Google Fit connecté). */
    @JavascriptInterface
    public boolean hasStepsReadPermission() {
        try {
            if (getHealthConnectSdkStatus() != HealthConnectClient.SDK_AVAILABLE) {
                return false;
            }
            return HealthConnectAuthHelper.hasStepsReadPermissionSync(appContext);
        } catch (Throwable t) {
            Log.w(TAG, "hasStepsReadPermission: " + t.getMessage());
            return false;
        }
    }

    /** Nombre de permissions HC lues accordées (tous types worker). */
    @JavascriptInterface
    public int getHealthConnectGrantedCount() {
        try {
            if (getHealthConnectSdkStatus() != HealthConnectClient.SDK_AVAILABLE) {
                return 0;
            }
            return HealthConnectAuthHelper.countGrantedSync(appContext);
        } catch (Throwable t) {
            Log.w(TAG, "getHealthConnectGrantedCount: " + t.getMessage());
            return 0;
        }
    }

    /**
     * Vérifie la disponibilité de Health Connect sur le device et, si l'app
     * provider est manquante ou doit être mise à jour, lance immédiatement le
     * Play Store sur la fiche d'installation (deep-linkée vers l'onboarding HC).
     *
     * <ul>
     *   <li>{@code 0} → HC installé et utilisable, rien à faire.</li>
     *   <li>{@code 1} → HC installé mais nécessite une mise à jour — Play Store ouvert.</li>
     *   <li>{@code 2} → HC absent (Android &lt; 14 typiquement) — Play Store ouvert.</li>
     *   <li>{@code 3} → device incompatible (très ancien) — rien fait.</li>
     * </ul>
     *
     * Idempotent — peut être appelé plusieurs fois sans effet bord si HC est
     * déjà OK.
     */
    @JavascriptInterface
    public int ensureHealthConnectInstalled() {
        int status = getHealthConnectSdkStatus();
        if (status == HealthConnectClient.SDK_AVAILABLE) {
            dismissInstallDialogIfShowing();
            clearInstallDismissed();
            return 0;
        }
        if (status == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
            Log.i(TAG, "Health Connect doit être mis à jour → popup confirmation.");
            showHealthConnectInstallDialog(true);
            return 1;
        }
        if (status == HealthConnectClient.SDK_UNAVAILABLE) {
            Log.i(TAG, "Health Connect non installé → popup installation.");
            if (shouldShowInstallDialog()) {
                showHealthConnectInstallDialog(false);
            } else {
                Log.i(TAG, "Popup installation HC ignorée (refus récent).");
            }
            return 2;
        }
        Log.w(TAG, "HealthConnect SDK status inattendu = " + status);
        return 3;
    }

    private boolean isHealthConnectPackageInstalled() {
        try {
            appContext.getPackageManager().getPackageInfo(HC_PROVIDER_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private int getHealthConnectSdkStatus() {
        try {
            // Android 14+ : HC intégré au système — ne pas exiger le package Play Store.
            if (Build.VERSION.SDK_INT >= 34) {
                int systemStatus = HealthConnectClient.getSdkStatus(appContext);
                if (systemStatus == HealthConnectClient.SDK_AVAILABLE) {
                    return systemStatus;
                }
            }
            if (!isHealthConnectPackageInstalled()) {
                return HealthConnectClient.SDK_UNAVAILABLE;
            }
            return HealthConnectClient.getSdkStatus(appContext, HC_PROVIDER_PACKAGE);
        } catch (Throwable t) {
            Log.w(TAG, "getSdkStatus a échoué : " + t.getMessage());
            return HealthConnectClient.SDK_UNAVAILABLE;
        }
    }

    private void dismissInstallDialogIfShowing() {
        Activity activity = activityRef.get();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            AlertDialog dialog = installDialogRef != null ? installDialogRef.get() : null;
            if (dialog != null && dialog.isShowing()) {
                dialog.dismiss();
            }
            installDialogRef = null;
        });
    }

    private SharedPreferences hcPrefs() {
        return appContext.getSharedPreferences(PREFS_HC, Context.MODE_PRIVATE);
    }

    private boolean shouldShowInstallDialog() {
        long dismissedAt = hcPrefs().getLong(KEY_INSTALL_DISMISSED_AT, 0L);
        if (dismissedAt <= 0L) {
            return true;
        }
        return System.currentTimeMillis() - dismissedAt >= INSTALL_DISMISS_COOLDOWN_MS;
    }

    private void markInstallDismissed() {
        hcPrefs().edit().putLong(KEY_INSTALL_DISMISSED_AT, System.currentTimeMillis()).apply();
    }

    private void clearInstallDismissed() {
        hcPrefs().edit().remove(KEY_INSTALL_DISMISSED_AT).apply();
    }

    /**
     * Popup natif (AlertDialog) qui explique pourquoi PCPTherapy a besoin de
     * Health Connect, avant de rediriger l'utilisateur vers le Play Store.
     * L'utilisateur peut refuser — l'app continue, simplement sans sync santé.
     */
    private void showHealthConnectInstallDialog(boolean needsUpdate) {
        Activity activity = activityRef.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            // Pas d'Activity → fallback direct sur le Play Store sans popup.
            launchPlayStoreForHealthConnect();
            return;
        }
        String title = needsUpdate
            ? "Mettre à jour Health Connect"
            : "Installer Health Connect";
        String message = needsUpdate
            ? "PCPTherapy synchronise vos données santé (pas, fréquence cardiaque, "
                + "poids…) avec votre médecin via l'application Health Connect "
                + "de Google.\n\nUne mise à jour est requise pour continuer. "
                + "Voulez-vous l'installer maintenant ?"
            : "PCPTherapy a besoin de l'application Health Connect de Google "
                + "pour synchroniser vos données d'activité physique (pas, "
                + "fréquence cardiaque, poids, sommeil…) avec votre médecin.\n\n"
                + "Voulez-vous l'installer maintenant depuis le Play Store ?";
        String positive = needsUpdate ? "Mettre à jour" : "Installer";
        activity.runOnUiThread(() -> {
            try {
                if (getHealthConnectSdkStatus() == HealthConnectClient.SDK_AVAILABLE) {
                    dismissInstallDialogIfShowing();
                    return;
                }
                dismissInstallDialogIfShowing();
                AlertDialog dialog = new AlertDialog.Builder(activity)
                    .setTitle(title)
                    .setMessage(message)
                    .setCancelable(true)
                    .setPositiveButton(positive, (d, w) -> launchPlayStoreForHealthConnect())
                    .setNegativeButton("Plus tard", (d, w) -> {
                        Log.i(TAG, "Utilisateur a refusé l'installation HC.");
                        if (!needsUpdate) {
                            markInstallDismissed();
                        }
                    })
                    .create();
                installDialogRef = new WeakReference<>(dialog);
                dialog.show();
            } catch (Throwable t) {
                Log.w(TAG, "AlertDialog install HC a échoué : " + t.getMessage()
                    + " — fallback direct Play Store.");
                launchPlayStoreForHealthConnect();
            }
        });
    }

    /**
     * Affiche un popup expliquant à l'utilisateur pourquoi PCPTherapy a besoin
     * des permissions Health Connect, AVANT le déclenchement de l'écran système
     * de Google. Le résultat est renvoyé au JS via {@code window.__pcpHcConfirm[requestId](true|false)}.
     *
     * @param requestId identifiant arbitraire généré côté JS pour matcher la réponse
     */
    @JavascriptInterface
    public void confirmPermissionRationale(String requestId) {
        Activity activity = activityRef.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()
            || requestId == null) {
            resolvePermissionRationale(requestId, true); // dégradé silencieux → on procède
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                new AlertDialog.Builder(activity)
                    .setTitle("Autoriser l'accès à vos données santé")
                    .setMessage(
                        "PCPTherapy a besoin de lire vos données Health Connect "
                            + "(pas, distance, calories, fréquence cardiaque, poids…) "
                            + "afin que votre médecin puisse suivre votre activité "
                            + "physique entre les consultations.\n\n"
                            + "Vos données sont transmises de manière sécurisée et "
                            + "ne sont visibles que par votre équipe soignante.\n\n"
                            + "Sur l'écran suivant, Google Health Connect vous demandera "
                            + "de cocher les types de données à partager."
                    )
                    .setCancelable(true)
                    .setPositiveButton("Continuer", (d, w) -> {
                        d.dismiss();
                        launchHealthConnectPermissionsUi(requestId);
                    })
                    .setNegativeButton("Plus tard",
                        (d, w) -> resolvePermissionRationale(requestId, false))
                    .setOnCancelListener(
                        d -> resolvePermissionRationale(requestId, false))
                    .show();
            } catch (Throwable t) {
                Log.w(TAG, "AlertDialog perms HC a échoué : " + t.getMessage());
                resolvePermissionRationale(requestId, true); // procède malgré tout
            }
        });
    }

    private void launchHealthConnectPermissionsUi(String rationaleRequestId) {
        pendingRationaleRequestId = rationaleRequestId;
        if (getHealthConnectSdkStatus() != HealthConnectClient.SDK_AVAILABLE) {
            Log.w(TAG, "HC indisponible — impossible d'ouvrir l'écran permissions.");
            resolvePermissionRationale(rationaleRequestId, false);
            return;
        }
        if (hcPermissionLauncher == null) {
            Log.w(TAG, "hcPermissionLauncher non attaché — fallback échec.");
            resolvePermissionRationale(rationaleRequestId, false);
            return;
        }
        Activity activity = activityRef.get();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            resolvePermissionRationale(rationaleRequestId, false);
            return;
        }
        try {
            hcPermissionLauncher.launch(HealthConnectAuthHelper.allReadPermissions());
        } catch (Throwable t) {
            Log.e(TAG, "Lancement écran permissions HC échoué : " + t.getMessage(), t);
            pendingRationaleRequestId = null;
            resolvePermissionRationale(rationaleRequestId, false);
        }
    }

    private void notifyJsHealthAuthorized(int granted) {
        WebView webView = webViewRef.get();
        Activity activity = activityRef.get();
        if (webView == null || activity == null) {
            return;
        }
        String js = "(function(){try{"
            + "window.dispatchEvent(new CustomEvent('pcp-health-authorized',{detail:{granted:"
            + granted + "}}));"
            + "}catch(e){}})();";
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.w(TAG, "notifyJsHealthAuthorized: " + t.getMessage());
            }
        });
    }

    private void resolvePermissionRationale(String requestId, boolean confirmed) {
        WebView webView = webViewRef.get();
        Activity activity = activityRef.get();
        if (webView == null || activity == null || requestId == null) return;
        String safeId = requestId.replaceAll("[^a-zA-Z0-9_-]", "");
        String js = "(function(){try{"
            + "var cb = window.__pcpHcConfirm && window.__pcpHcConfirm['" + safeId + "'];"
            + "if (typeof cb === 'function') { delete window.__pcpHcConfirm['" + safeId + "']; cb(" + confirmed + "); }"
            + "}catch(e){}})();";
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Throwable t) {
                Log.w(TAG, "evaluateJavascript a échoué : " + t.getMessage());
            }
        });
    }

    private void launchPlayStoreForHealthConnect() {
        Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse(HC_PLAY_STORE_URI));
        market.setPackage("com.android.vending");
        market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            appContext.startActivity(market);
            return;
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "Play Store natif indisponible — fallback web.");
        } catch (Exception e) {
            Log.w(TAG, "Lancement Play Store échoué : " + e.getMessage());
        }
        // Fallback : ouvre la fiche dans le navigateur (emulator, devices Huawei, etc.).
        try {
            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(HC_PLAY_STORE_WEB_URI));
            browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            appContext.startActivity(browser);
        } catch (Exception e) {
            Log.e(TAG, "Aucun moyen d'ouvrir Play Store ni navigateur : " + e.getMessage());
        }
    }

    /**
     * Lit une ressource du backend en utilisant le JWT stocké côté natif.
     * Le token n'est JAMAIS exposé au JS — seul le body de la réponse est
     * renvoyé. Utilisé par le panneau de test pour afficher les données
     * persistées (/me/health/*).
     *
     * @param path chemin sans le host, p.ex. "/api/v1/patients/me/health/daily?limit=30"
     * @return JSON enveloppe : {"status": int, "body": "..."} ou {"error": "..."}
     */
    @JavascriptInterface
    public String fetchBackend(String path) {
        String token = store.getToken();
        if (token == null || token.isEmpty()) {
            return "{\"error\":\"no_token\"}";
        }
        if (path == null || path.isEmpty()) {
            return "{\"error\":\"empty_path\"}";
        }
        String base = store.getApiBase();
        String url = base + (path.startsWith("/") ? path : "/" + path);
        try {
            Request request = new Request.Builder()
                .url(url)
                .header("Authorization", "Bearer " + token)
                .header("Accept", "application/json")
                .get()
                .build();
            try (Response response = http().newCall(request).execute()) {
                String body = response.body() != null ? response.body().string() : "";
                JSONObject wrapper = new JSONObject();
                wrapper.put("status", response.code());
                wrapper.put("body", body);
                return wrapper.toString();
            }
        } catch (Exception e) {
            try {
                return new JSONObject().put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()).toString();
            } catch (Exception ignored) {
                return "{\"error\":\"unknown\"}";
            }
        }
    }

    /**
     * Renvoie l'état de la dernière sync sous forme de chaîne JSON.
     * Format : {@code {"lastSyncAt":..., "lastInserted":..., "lastMessage":..., "hasToken":bool}}
     */
    /**
     * Saves a blob file from the WebView (JSON: base64, mimeType, filename) and opens the share sheet.
     */
    @JavascriptInterface
    public void saveBlobDownload(String payloadJson) {
        Activity activity = activityRef.get();
        if (activity == null || payloadJson == null || payloadJson.isEmpty()) {
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                JSONObject payload = new JSONObject(payloadJson);
                if (payload.has("error")) {
                    Log.w(TAG, "saveBlobDownload JS error: " + payload.optString("error"));
                    showDownloadError(activity);
                    return;
                }
                String base64 = payload.optString("base64", "");
                if (base64.isEmpty()) {
                    showDownloadError(activity);
                    return;
                }
                String mimeType = payload.optString("mimeType", "application/octet-stream");
                String filename = sanitizeFilename(payload.optString("filename", "document"));
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                if (data.length == 0) {
                    showDownloadError(activity);
                    return;
                }
                File dir = new File(activity.getCacheDir(), "downloads");
                if (!dir.exists() && !dir.mkdirs()) {
                    showDownloadError(activity);
                    return;
                }
                File out = new File(dir, filename);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(data);
                }
                String authority = activity.getPackageName() + ".fileprovider";
                Uri uri = FileProvider.getUriForFile(activity, authority, out);
                Intent share = new Intent(Intent.ACTION_SEND);
                share.setType(mimeType);
                share.putExtra(Intent.EXTRA_STREAM, uri);
                share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(Intent.createChooser(share, "Enregistrer"));
            } catch (Exception e) {
                Log.e(TAG, "saveBlobDownload failed", e);
                showDownloadError(activity);
            }
        });
    }

    private static String sanitizeFilename(String name) {
        String trimmed = name == null ? "" : name.trim();
        String cleaned = trimmed.replaceAll("[\\\\/:*?\"<>|\\n\\r]", "_");
        if (cleaned.isEmpty()) {
            cleaned = "document";
        }
        return cleaned.length() > 120 ? cleaned.substring(0, 120) : cleaned;
    }

    private void showDownloadError(Activity activity) {
        new AlertDialog.Builder(activity)
            .setTitle("Téléchargement impossible")
            .setMessage("Réessayez dans quelques instants.")
            .setPositiveButton(android.R.string.ok, null)
            .show();
    }

    /** Retour haptique léger (pull-to-refresh offline, sync manuelle). */
    @JavascriptInterface
    public void playLightHaptic() {
        Activity activity = activityRef.get();
        if (activity == null) {
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Vibrator vibrator;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    VibratorManager manager =
                        (VibratorManager) activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                    vibrator = manager != null ? manager.getDefaultVibrator() : null;
                } else {
                    vibrator = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
                }
                if (vibrator == null || !vibrator.hasVibrator()) {
                    return;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createOneShot(18L, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vibrator.vibrate(18L);
                }
            } catch (Exception e) {
                Log.w(TAG, "playLightHaptic: " + e.getMessage());
            }
        });
    }

    /**
     * Partage les logs sans passer le rapport via JNI (évite crash WebView sur gros rapports).
     * Le natif récupère le texte via {@code evaluateJavascript}.
     */
    @JavascriptInterface
    public void requestShareSyncLogs() {
        WebView webView = webViewRef.get();
        Activity activity = activityRef.get();
        if (webView == null || activity == null) {
            return;
        }
        activity.runOnUiThread(() -> webView.evaluateJavascript(
            "(function(){try{if(window.PcpHealthLogExport&&window.PcpHealthLogExport.buildReportSync){"
                + "return window.PcpHealthLogExport.buildReportSync();}"
                + "}catch(e){}return ''})()",
            (ValueCallback<String>) value -> {
                String jsReport = decodeJsString(value);
                String report = mergeHealthConnectBlock(jsReport);
                if (report == null || report.trim().isEmpty()) {
                    notifyShareLogsResult(webView, false);
                    return;
                }
                shareSyncLogsInternal(activity, webView, report);
            }
        ));
    }

    private String mergeHealthConnectBlock(String jsReport) {
        if (jsReport == null || jsReport.trim().isEmpty()) {
            return jsReport;
        }
        String block = buildHealthConnectReportBlock();
        if (block.isEmpty()) {
            return jsReport;
        }
        int marker = jsReport.indexOf("\n\n--- Champs attendus");
        if (marker < 0) {
            return jsReport + block;
        }
        return jsReport.substring(0, marker) + block + jsReport.substring(marker);
    }

    private String buildHealthConnectReportBlock() {
        StringBuilder sb = new StringBuilder();
        sb.append("\n--- Health Connect (Android) ---\n");
        try {
            int hcStatus = peekHealthConnectStatus();
            String statusLabel =
                hcStatus == 0 ? "disponible"
                    : hcStatus == 1 ? "mise à jour requise"
                    : hcStatus == 2 ? "non installé"
                    : "indisponible";
            sb.append("Health Connect: ").append(statusLabel).append(" (code ").append(hcStatus).append(")\n");
        } catch (Exception e) {
            sb.append("Health Connect: erreur ").append(e.getMessage()).append("\n");
        }
        try {
            sb.append("Permissions HC accordées (types worker): ")
                .append(getHealthConnectGrantedCount())
                .append("\n");
        } catch (Exception e) {
            sb.append("Permissions HC: erreur ").append(e.getMessage()).append("\n");
        }
        try {
            Boolean stepsOk = hasStepsReadPermission();
            sb.append("Permission lecture Pas (PCPTherapy): ")
                .append(stepsOk == null ? "?" : (stepsOk ? "oui" : "non"))
                .append("\n");
        } catch (Exception e) {
            sb.append("Permission Pas: erreur ").append(e.getMessage()).append("\n");
        }
        try {
            JSONObject info = new JSONObject(getLastSyncInfo());
            sb.append("Token natif: ").append(info.optBoolean("hasToken") ? "oui" : "non").append("\n");
            sb.append("API base: ").append(info.optString("apiBase", "—")).append("\n");
            sb.append("Dernier outcome: ").append(info.optString("lastOutcome", "—")).append("\n");
            if (info.has("lastMessage") && !info.optString("lastMessage", "").isEmpty()) {
                sb.append("Dernier message: ").append(info.optString("lastMessage")).append("\n");
            }
            long lastSync = info.optLong("lastSyncAt", 0L);
            sb.append("Dernière sync OK: ")
                .append(lastSync > 0L ? new Date(lastSync).toString() : "jamais")
                .append("\n");
            sb.append("Inserts: samples=")
                .append(info.optInt("lastInserted", 0))
                .append(" aggregates=")
                .append(info.optInt("lastAggregatesInserted", 0))
                .append("\n");
        } catch (Exception e) {
            sb.append("Sync natif: erreur ").append(e.getMessage()).append("\n");
        }
        return sb.toString();
    }

    /** @deprecated Préférer {@link #requestShareSyncLogs()} — conservé pour compatibilité. */
    @JavascriptInterface
    public void shareSyncLogs(String reportText) {
        Activity activity = activityRef.get();
        WebView webView = webViewRef.get();
        if (activity == null || reportText == null || reportText.trim().isEmpty()) {
            if (webView != null) {
                notifyShareLogsResult(webView, false);
            }
            return;
        }
        if (reportText.length() > 512_000) {
            Log.w(TAG, "shareSyncLogs: rapport trop volumineux — bascule requestShareSyncLogs");
            requestShareSyncLogs();
            return;
        }
        activity.runOnUiThread(() -> shareSyncLogsInternal(activity, webView, reportText));
    }

    private void shareSyncLogsInternal(Activity activity, WebView webView, String reportText) {
        try {
            File dir = new File(activity.getCacheDir(), "health-logs");
            if (!dir.exists() && !dir.mkdirs()) {
                Log.w(TAG, "shareSyncLogs: impossible de créer le dossier cache");
                notifyShareLogsResult(webView, false);
                return;
            }
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            File out = new File(dir, "pcp-health-sync-" + stamp + ".txt");
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(reportText.getBytes(StandardCharsets.UTF_8));
            }
            String authority = activity.getPackageName() + ".fileprovider";
            Uri uri = FileProvider.getUriForFile(activity, authority, out);
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("text/plain");
            share.putExtra(Intent.EXTRA_STREAM, uri);
            share.putExtra(Intent.EXTRA_SUBJECT, "PCP Health Sync — rapport testeur");
            String preview = reportText.length() > 4000
                ? reportText.substring(0, 4000) + "…"
                : reportText;
            share.putExtra(Intent.EXTRA_TEXT, preview);
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(share, "Envoyer les logs santé"));
            notifyShareLogsResult(webView, true);
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "shareSyncLogs: aucune app de partage", e);
            notifyShareLogsResult(webView, false);
        } catch (Exception e) {
            Log.e(TAG, "shareSyncLogs failed", e);
            notifyShareLogsResult(webView, false);
        }
    }

    private void notifyShareLogsResult(WebView webView, boolean ok) {
        if (webView == null) {
            return;
        }
        webView.post(() -> webView.evaluateJavascript(
            "window.__pcpShareLogsDone&&window.__pcpShareLogsDone(" + (ok ? "true" : "false") + ")",
            null
        ));
    }

    private static String decodeJsString(String encoded) {
        if (encoded == null || "null".equals(encoded) || encoded.isEmpty()) {
            return "";
        }
        String trimmed = encoded.trim();
        if (trimmed.length() >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
            try {
                return new org.json.JSONObject("{ \"v\": " + trimmed + " }").getString("v");
            } catch (Exception e) {
                return trimmed.substring(1, trimmed.length() - 1)
                    .replace("\\n", "\n")
                    .replace("\\r", "\r")
                    .replace("\\t", "\t")
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\");
            }
        }
        return trimmed;
    }

    /**
     * Lecture directe Health Connect pour aligner l'UI sur l'app HC (sommeil nuit + vitaux récents).
     * Retourne JSON : {@code { today: {...}, vitals: {...} }} ou {@code { error: "..." }}.
     */
    @JavascriptInterface
    public String getHealthConnectDisplaySnapshot() {
        return HealthConnectAuthHelper.readDisplaySnapshotSync(appContext);
    }

    @JavascriptInterface
    public String getLastSyncInfo() {
        try {
            store.clearStaleErrorIfOlderThan(30L * 60L * 1000L);
            JSONObject json = new JSONObject();
            json.put("lastSyncAt", store.getLastSyncAt());
            json.put("lastAttemptAt", store.getLastAttemptAt());
            json.put("lastOutcome", store.getLastOutcome());
            json.put("lastDataSyncAt", store.getLastDataSyncAt());
            json.put("lastErrorAt", store.getLastSyncErrorAt());
            json.put("lastInserted", store.getLastSyncInserted());
            json.put("lastAggregatesInserted", store.getLastAggregatesInserted());
            json.put("lastMessage", store.getLastSyncMessage());
            json.put("hasToken", store.getToken() != null);
            json.put("apiBase", store.getApiBase());
            json.put("fullBackfillAt", store.getFullBackfillAt());
            json.put("backfillPending", store.isBackfillPending());
            json.put("backfillRunning", HealthSyncExecutor.INSTANCE.isBackfillRunning());
            return json.toString();
        } catch (Exception e) {
            return "{}";
        }
    }
}
