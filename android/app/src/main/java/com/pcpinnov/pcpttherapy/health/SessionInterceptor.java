package com.pcpinnov.pcpttherapy.health;

import android.content.Context;
import android.util.Log;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.pcpinnov.pcpttherapy.PcpOfflinePage;
import com.pcpinnov.pcpttherapy.PcpFileUploadHandler;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * WebViewClient qui injecte automatiquement un petit script JS dans la WebView
 * principale (frontend Next.js sur https://patient.pcpinnov.com) à chaque fin
 * de chargement de page.
 *
 * Le script injecté :
 *   1. Poll {@code GET /api/auth/session} (endpoint standard NextAuth) qui
 *      retourne {@code {user: {accessToken: "..."}}} grâce au callback
 *      {@code session()} défini dans frontend/src/auth.config.ts.
 *   2. Quand un access_token apparaît → {@code window.PcpHealthBridge.setToken(...)}
 *      → le natif chiffre le token + planifie la sync périodique 6h +
 *      déclenche un sync immédiat.
 *   3. La première fois (et seulement si Health Connect n'a aucune permission
 *      accordée), demande à l'utilisateur d'autoriser HC via le plugin capgo.
 *   4. Quand la session redevient nulle (logout) → {@code clearToken()} natif.
 *
 * Tout est fait <strong>sans aucune modification côté frontend</strong> — c'est
 * le natif qui scrute la session NextAuth via un endpoint déjà exposé.
 *
 * L'injection se fait uniquement sur les pages dont l'URL contient
 * « pcpinnov.com » pour ne pas polluer d'éventuelles ressources tierces.
 */
public class SessionInterceptor extends BridgeWebViewClient {

    private static final String TAG = "SessionInterceptor";
    private final Bridge capacitorBridge;

    /**
     * Script auto-installé (idempotent grâce au flag {@code window.__pcpHealthHook}).
     * Polle la session toutes les 30 s et au retour au foreground.
     */
    private static final String INJECT_JS =
        "(function(){\n" +
        "  if (window.__pcpHealthHook) return;\n" +
        "  window.__pcpHealthHook = true;\n" +
        "  var PERMS = {\n" +
        "    read: [\n" +
        "      'steps','calories','sleep','respiratoryRate','oxygenSaturation',\n" +
        "      'restingHeartRate','heartRateVariability','bodyTemperature','heartRate','vo2Max','workouts'\n" +
        "    ],\n" +
        "    write: []\n" +
        "  };\n" +
        "  var HEALTH_AUTH_ATTEMPTED_KEY = 'pcpHealthConnectAuthGroupedV1';\n" +
        "  var HC_INSTALL_PENDING_KEY = 'pcpHcInstallPending';\n" +
        "  var HC_DECLINED_KEY = 'pcpHcUserDeclinedRationale';\n" +
        "  var lastToken = null;\n" +
        "  var hcAuthInFlight = false;\n" +
        "  var sessionRole = null;\n" +
        "  var onboardingDone = true;\n" +
        "  function log(m){ try{ console.log('[PcpHealth]', m); }catch(e){} }\n" +
        "  function isOnboardingPath(){\n" +
        "    try { return /^\\/onboarding(\\/|$)/.test(window.location.pathname || ''); }\n" +
        "    catch(e) { return false; }\n" +
        "  }\n" +
        "  function patientIdFromAccessToken(token){\n" +
        "    if (!token || typeof token !== 'string') return '';\n" +
        "    try {\n" +
        "      var payload = token.split('.')[1];\n" +
        "      if (!payload) return '';\n" +
        "      var json = JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')));\n" +
        "      return typeof json.sub === 'string' ? json.sub : '';\n" +
        "    } catch(e) { return ''; }\n" +
        "  }\n" +
        "  function hydrateSyncStateFromToken(token){\n" +
        "    if (!token) return;\n" +
        "    try {\n" +
        "      var storage = window.PcpHealthSyncStorage;\n" +
        "      if (!storage) return;\n" +
        "      storage.ensureSyncPatientScope(token);\n" +
        "      void storage.hydrateFromNative(token).then(function(){\n" +
        "        storage.reconcileLocalBackfillState(token);\n" +
        "      });\n" +
        "    } catch(e) {}\n" +
        "  }\n" +
        "  function applySessionUser(user, token){\n" +
        "    if (!user) {\n" +
        "      sessionRole = null;\n" +
        "      onboardingDone = true;\n" +
        "      window.__pcpHealthSyncPatientId = null;\n" +
        "      return;\n" +
        "    }\n" +
        "    sessionRole = user.role || null;\n" +
        "    onboardingDone = user.onboardingCompleted !== false;\n" +
        "    var pid = user.id || patientIdFromAccessToken(token) || '';\n" +
        "    if (pid) window.__pcpHealthSyncPatientId = pid;\n" +
        "    if (token) hydrateSyncStateFromToken(token);\n" +
        "  }\n" +
        "  function isPatientHome(){\n" +
        "    try { return /\\/patient\\/home/.test(window.location.pathname || ''); }\n" +
        "    catch(e) { return false; }\n" +
        "  }\n" +
        "  function shouldPromptHealthConnect(){\n" +
        "    if (sessionRole && sessionRole !== 'patient') return false;\n" +
        "    if (isOnboardingPath()) return false;\n" +
        "    if (sessionRole === 'patient' && onboardingDone === false) return false;\n" +
        "    return true;\n" +
        "  }\n" +
        "  var __pcpLastPath = '';\n" +
        "  function authAlreadyAttempted(){\n" +
        "    try { return sessionStorage.getItem(HEALTH_AUTH_ATTEMPTED_KEY) === '1'; }\n" +
        "    catch(e) { return false; }\n" +
        "  }\n" +
        "  function markAuthAttempted(){\n" +
        "    try { sessionStorage.setItem(HEALTH_AUTH_ATTEMPTED_KEY, '1'); } catch(e) {}\n" +
        "  }\n" +
        "  function clearHcAuthBlock(){\n" +
        "    try {\n" +
        "      sessionStorage.removeItem(HEALTH_AUTH_ATTEMPTED_KEY);\n" +
        "      sessionStorage.removeItem(HC_DECLINED_KEY);\n" +
        "      sessionStorage.removeItem(HC_INSTALL_PENDING_KEY);\n" +
        "    } catch(e) {}\n" +
        "  }\n" +
        "  function peekHcStatus(){\n" +
        "    var bridge = window.PcpHealthBridge;\n" +
        "    if (bridge && bridge.peekHealthConnectStatus) return bridge.peekHealthConnectStatus();\n" +
        "    if (bridge && bridge.ensureHealthConnectInstalled) return bridge.ensureHealthConnectInstalled();\n" +
        "    return 3;\n" +
        "  }\n" +
        "  function onHcMaybeReady(){\n" +
        "    try {\n" +
        "      if (peekHcStatus() !== 0) return;\n" +
        "      if (sessionStorage.getItem(HC_INSTALL_PENDING_KEY) === '1') {\n" +
        "        clearHcAuthBlock();\n" +
        "        log('Health Connect installé — relance demande autorisation');\n" +
        "      }\n" +
        "    } catch(e) {}\n" +
        "  }\n" +
        "  function emitHealthAuthorized(granted){\n" +
        "    try {\n" +
        "      window.dispatchEvent(new CustomEvent('pcp-health-authorized', { detail: { granted: granted } }));\n" +
        "    } catch(e) {}\n" +
        "  }\n" +
        "  function countHcReadGrantedNative(){\n" +
        "    var bridge = window.PcpHealthBridge;\n" +
        "    if (!bridge || !bridge.getHealthConnectGrantedCount) return 0;\n" +
        "    try { return bridge.getHealthConnectGrantedCount() | 0; } catch(e) { return 0; }\n" +
        "  }\n" +
        "  function nativeConfirm(){\n" +
        "    return new Promise(function(resolve){\n" +
        "      var bridge = window.PcpHealthBridge;\n" +
        "      if (!bridge || !bridge.confirmPermissionRationale) { resolve(true); return; }\n" +
        "      var id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);\n" +
        "      window.__pcpHcConfirm = window.__pcpHcConfirm || {};\n" +
        "      window.__pcpHcConfirm[id] = function(ok){ resolve(!!ok); };\n" +
        "      try { bridge.confirmPermissionRationale(id); }\n" +
        "      catch(e){ delete window.__pcpHcConfirm[id]; resolve(true); }\n" +
        "      setTimeout(function(){\n" +
        "        if (window.__pcpHcConfirm[id]) {\n" +
        "          delete window.__pcpHcConfirm[id];\n" +
        "          resolve(false);\n" +
        "        }\n" +
        "      }, 120000);\n" +
        "    });\n" +
        "  }\n" +
        "  async function maybeAskHcPerms(){\n" +
        "    try {\n" +
        "      if (!shouldPromptHealthConnect()) return;\n" +
        "      if (!isPatientHome()) return;\n" +
        "      if (hcAuthInFlight) return;\n" +
        "      onHcMaybeReady();\n" +
        "      var bridge = window.PcpHealthBridge;\n" +
        "      var avail = peekHcStatus();\n" +
        "      if (avail !== 0) {\n" +
        "        try { sessionStorage.setItem(HC_INSTALL_PENDING_KEY, '1'); } catch(e) {}\n" +
        "        if (bridge && bridge.ensureHealthConnectInstalled) bridge.ensureHealthConnectInstalled();\n" +
        "        log('Health Connect indisponible (' + avail + ') → install/maj');\n" +
        "        return;\n" +
        "      }\n" +
        "      try { if (bridge && bridge.peekHealthConnectStatus) bridge.peekHealthConnectStatus(); } catch(e) {}\n" +
        "      var before = countHcReadGrantedNative();\n" +
        "      if (before > 0) {\n" +
        "        log('Health Connect déjà autorisé (' + before + ' permissions)');\n" +
        "        emitHealthAuthorized(before);\n" +
        "        return;\n" +
        "      }\n" +
        "      try { if (sessionStorage.getItem(HC_DECLINED_KEY) === '1') return; } catch(e) {}\n" +
        "      if (authAlreadyAttempted()) return;\n" +
        "      hcAuthInFlight = true;\n" +
        "      try {\n" +
        "        log('Popup rationale puis écran Health Connect système…');\n" +
        "        var ok = await nativeConfirm();\n" +
        "        if (!ok) {\n" +
        "          try { sessionStorage.setItem(HC_DECLINED_KEY, '1'); } catch(e) {}\n" +
        "          log('Permissions HC refusées par l\\'utilisateur (popup natif)');\n" +
        "          return;\n" +
        "        }\n" +
        "        await new Promise(function(r){ setTimeout(r, 400); });\n" +
        "        var after = countHcReadGrantedNative();\n" +
        "        if (after > 0) {\n" +
        "          markAuthAttempted();\n" +
        "          if (before === 0) emitHealthAuthorized(after);\n" +
        "        } else {\n" +
        "          log('Permissions HC non accordées — nouvel essai possible');\n" +
        "        }\n" +
        "      } finally {\n" +
        "        hcAuthInFlight = false;\n" +
        "      }\n" +
        "    } catch(e) { log('HC perms erreur: ' + e); hcAuthInFlight = false; }\n" +
        "  }\n" +
        "  async function pollSession(){\n" +
        "    try {\n" +
        "      var bridge = window.PcpHealthBridge;\n" +
        "      if (!bridge) return;\n" +
        "      var res = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });\n" +
        "      if (!res.ok) return;\n" +
        "      var data = await res.json();\n" +
        "      var token = (data && data.user) ? data.user.accessToken : null;\n" +
        "      applySessionUser(data && data.user ? data.user : null, token);\n" +
        "      if (token && token !== lastToken) {\n" +
        "        lastToken = token;\n" +
        "        log('Session NextAuth → token transmis au natif');\n" +
        "        bridge.setToken(token);\n" +
        "        hydrateSyncStateFromToken(token);\n" +
        "        __pcpLastPath = '';\n" +
        "        watchRouteForHealthPrompt();\n" +
        "      } else if (token) {\n" +
        "        lastToken = token;\n" +
        "      }\n" +
        "      if (!token && lastToken) {\n" +
        "        lastToken = null;\n" +
        "        log('Session perdue → clearToken natif');\n" +
        "        if (bridge.clearToken) bridge.clearToken();\n" +
        "      }\n" +
        "    } catch(e) { /* silent — page peut être en transit */ }\n" +
        "  }\n" +
        "  function watchRouteForHealthPrompt(){\n" +
        "    try {\n" +
        "      var path = window.location.pathname || '';\n" +
        "      if (path === __pcpLastPath) return;\n" +
        "      __pcpLastPath = path;\n" +
        "      if (!lastToken || !shouldPromptHealthConnect()) return;\n" +
        "      if (isPatientHome()) {\n" +
        "        log('Arrivée accueil patient — consentement Health Connect');\n" +
        "        maybeAskHcPerms();\n" +
        "        if (window.schedulePcpBackgroundHealthSync) window.schedulePcpBackgroundHealthSync();\n" +
        "      }\n" +
        "    } catch(e) {}\n" +
        "  }\n" +
        "  pollSession();\n" +
        "  setInterval(pollSession, 30000);\n" +
        "  window.addEventListener('popstate', watchRouteForHealthPrompt);\n" +
        "  setInterval(watchRouteForHealthPrompt, 800);\n" +
        "  document.addEventListener('visibilitychange', function(){\n" +
        "    if (document.visibilityState === 'visible') {\n" +
        "      onHcMaybeReady();\n" +
        "      pollSession();\n" +
        "      watchRouteForHealthPrompt();\n" +
        "    }\n" +
        "  });\n" +
        "})();";

    /** Blob download: intercept <a download href="blob:..."> before revokeObjectURL. */
    private static final String DOWNLOAD_INJECT_JS =
        "(function(){\n" +
        "  if (window.__pcpDownloadHook) return;\n" +
        "  window.__pcpDownloadHook = true;\n" +
        "  function hasNativeDownload(){\n" +
        "    return (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pcpDownloadBlob)\n" +
        "      || (window.PcpHealthBridge && window.PcpHealthBridge.saveBlobDownload);\n" +
        "  }\n" +
        "  function postBlobDownload(payload){\n" +
        "    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pcpDownloadBlob) {\n" +
        "      window.webkit.messageHandlers.pcpDownloadBlob.postMessage(payload);\n" +
        "      return true;\n" +
        "    }\n" +
        "    if (window.PcpHealthBridge && window.PcpHealthBridge.saveBlobDownload) {\n" +
        "      window.PcpHealthBridge.saveBlobDownload(JSON.stringify(payload));\n" +
        "      return true;\n" +
        "    }\n" +
        "    return false;\n" +
        "  }\n" +
        "  window.__pcpDeliverBlobDownload = async function(href, filename){\n" +
        "    if (!hasNativeDownload()) return false;\n" +
        "    try {\n" +
        "      var response = await fetch(href);\n" +
        "      var blob = await response.blob();\n" +
        "      var dataUrl = await new Promise(function(resolve, reject){\n" +
        "        var reader = new FileReader();\n" +
        "        reader.onloadend = function(){ resolve(reader.result); };\n" +
        "        reader.onerror = function(){ reject(reader.error); };\n" +
        "        reader.readAsDataURL(blob);\n" +
        "      });\n" +
        "      var parts = String(dataUrl).split(',');\n" +
        "      postBlobDownload({\n" +
        "        base64: parts.length > 1 ? parts[1] : '',\n" +
        "        mimeType: blob.type || 'application/octet-stream',\n" +
        "        filename: filename || 'document'\n" +
        "      });\n" +
        "      return true;\n" +
        "    } catch (e) {\n" +
        "      postBlobDownload({ error: String(e) });\n" +
        "      return false;\n" +
        "    }\n" +
        "  };\n" +
        "  var origRevoke = URL.revokeObjectURL.bind(URL);\n" +
        "  URL.revokeObjectURL = function(url){\n" +
        "    var href = (typeof url === 'string') ? url : (url && url.href ? url.href : '');\n" +
        "    if (href && href.indexOf('blob:') === 0 && hasNativeDownload()) {\n" +
        "      setTimeout(function(){ origRevoke(url); }, 90000);\n" +
        "      return;\n" +
        "    }\n" +
        "    return origRevoke(url);\n" +
        "  };\n" +
        "  var origAnchorClick = HTMLAnchorElement.prototype.click;\n" +
        "  HTMLAnchorElement.prototype.click = function(){\n" +
        "    if (this && this.href && this.download && String(this.href).indexOf('blob:') === 0 && hasNativeDownload()) {\n" +
        "      window.__pcpDeliverBlobDownload(this.href, this.download || 'document');\n" +
        "      return;\n" +
        "    }\n" +
        "    return origAnchorClick.call(this);\n" +
        "  };\n" +
        "})();";

    /** Caméra + galerie pour les inputs file image (parité iOS WebFileUploadInjection). */
    private static final String FILE_UPLOAD_INJECT_JS =
        "(function(){\n" +
        "  if (window.__pcpFileUploadHook) return;\n" +
        "  window.__pcpFileUploadHook = true;\n" +
        "  function uploadBridge(){ return window." + PcpFileUploadHandler.JS_NAME + "; }\n" +
        "  function applyToInput(input, b64, mime, name){\n" +
        "    if (!input || !b64) return;\n" +
        "    try {\n" +
        "      var bin = atob(b64);\n" +
        "      var len = bin.length;\n" +
        "      var bytes = new Uint8Array(len);\n" +
        "      for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);\n" +
        "      var file = new File([bytes], name || 'photo.jpg', { type: mime || 'image/jpeg' });\n" +
        "      var dt = new DataTransfer();\n" +
        "      dt.items.add(file);\n" +
        "      input.files = dt.files;\n" +
        "      input.dispatchEvent(new Event('change', { bubbles: true }));\n" +
        "    } catch (e) { try { console.error('[PcpUpload]', e); } catch (_) {} }\n" +
        "  }\n" +
        "  window.__pcpApplyPickedFile = function(b64, mime, name){\n" +
        "    var input = window.__pcpPendingFileInput;\n" +
        "    window.__pcpPendingFileInput = null;\n" +
        "    applyToInput(input, b64, mime, name);\n" +
        "  };\n" +
        "  window.__pcpApplyPickedFileFromBridge = function(){\n" +
        "    var bridge = uploadBridge();\n" +
        "    if (!bridge || !bridge.consumePickedImage) return;\n" +
        "    var b64 = bridge.consumePickedImage();\n" +
        "    if (!b64) return;\n" +
        "    var mime = bridge.consumePickedImageMime ? bridge.consumePickedImageMime() : 'image/jpeg';\n" +
        "    var name = bridge.consumePickedImageName ? bridge.consumePickedImageName() : 'photo.jpg';\n" +
        "    var input = window.__pcpPendingFileInput;\n" +
        "    window.__pcpPendingFileInput = null;\n" +
        "    applyToInput(input, b64, mime, name);\n" +
        "  };\n" +
        "  var origClick = HTMLInputElement.prototype.click;\n" +
        "  HTMLInputElement.prototype.click = function() {\n" +
        "    if (this && this.type === 'file') {\n" +
        "      var accept = (this.accept || '').toLowerCase();\n" +
        "      var imageOnly = !accept || accept.indexOf('image') >= 0;\n" +
        "      var bridge = uploadBridge();\n" +
        "      if (imageOnly && bridge && bridge.pickImage) {\n" +
        "        window.__pcpPendingFileInput = this;\n" +
        "        bridge.pickImage();\n" +
        "        return;\n" +
        "      }\n" +
        "    }\n" +
        "    return origClick.call(this);\n" +
        "  };\n" +
        "})();";

    /** Empêche le grossissement auto du texte (accessibilité système → WebView). */
    private static final String MOBILE_TYPO_FIX_JS =
        "(function(){"
            + "if(window.__pcpMobileTypoFix)return;"
            + "window.__pcpMobileTypoFix=true;"
            + "document.documentElement.classList.add('pcp-mobile-app');"
            + "if(!document.getElementById('pcp-mobile-typography')){"
            + "var s=document.createElement('style');"
            + "s.id='pcp-mobile-typography';"
            + "s.textContent='html.pcp-mobile-app,html.pcp-mobile-app body{"
            + "-webkit-text-size-adjust:100%;text-size-adjust:100%;font-size:16px}';"
            + "(document.head||document.documentElement).appendChild(s);"
            + "}"
            + "})();";

    private static final String HEALTH_SYNC_CONSTANTS_ASSET = "public/health-sync-constants.js";
    private static final String HEALTH_LOG_EXPORT_ASSET = "public/health-log-export.js";
    private static final String HEALTH_SERVER_BACKFILL_PROBE_ASSET = "public/health-server-backfill-probe.js";
    private static final String HEALTH_SYNC_STORAGE_ASSET = "public/health-android-sync-storage.js";
    private static final String HEALTH_HOOK_ASSET = "public/health-android-hook.js";
    private static final String HEALTH_DISPLAY_REFRESH_ASSET = "public/health-display-refresh.js";
    private static final String HEALTH_ANDROID_DISPLAY_SYNC_ASSET = "public/health-android-display-sync.js";
    private static final String HEALTH_SYNC_INDICATOR_ASSET = "public/health-sync-indicator.js";

    public SessionInterceptor(Bridge bridge) {
        super(bridge);
        this.capacitorBridge = bridge;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request != null && request.isForMainFrame() && capacitorBridge.getErrorUrl() != null) {
            PcpOfflinePage.configureWebView(view);
        }
        super.onReceivedError(view, request, error);
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        super.onPageStarted(view, url, favicon);
        if (url == null) {
            return;
        }
        if (PcpOfflinePage.isOfflineUrl(url)) {
            PcpOfflinePage.configureWebView(view);
        } else {
            PcpOfflinePage.clearWebView(view);
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        if (url == null) {
            return;
        }
        if (PcpOfflinePage.isOfflineUrl(url)) {
            PcpOfflinePage.configureWebView(view);
            PcpOfflinePage.injectSafeAreaInsets(view);
            return;
        }
        if (!url.contains("pcpinnov.com") && !url.startsWith("https://localhost")) {
            return;
        }
        try {
            view.evaluateJavascript(INJECT_JS, null);
            view.evaluateJavascript(MOBILE_TYPO_FIX_JS, null);
            view.evaluateJavascript(DOWNLOAD_INJECT_JS, null);
            view.evaluateJavascript(FILE_UPLOAD_INJECT_JS, null);
            injectAssetScript(view, HEALTH_SYNC_CONSTANTS_ASSET);
            injectAssetScript(view, HEALTH_LOG_EXPORT_ASSET);
            injectAssetScript(view, HEALTH_DISPLAY_REFRESH_ASSET);
            injectAssetScript(view, HEALTH_ANDROID_DISPLAY_SYNC_ASSET);
            injectAssetScript(view, HEALTH_SERVER_BACKFILL_PROBE_ASSET);
            injectAssetScript(view, HEALTH_SYNC_STORAGE_ASSET);
            injectAssetScript(view, HEALTH_SYNC_INDICATOR_ASSET);
            injectAssetScript(view, HEALTH_HOOK_ASSET);
        } catch (Throwable t) {
            Log.w(TAG, "evaluateJavascript a échoué : " + t.getMessage());
        }
    }

    private void injectAssetScript(WebView view, String assetPath) {
        Context ctx = view.getContext();
        if (ctx == null) {
            return;
        }
        try (InputStream in = ctx.getAssets().open(assetPath)) {
            String script = readUtf8(in);
            if (!script.isEmpty()) {
                view.evaluateJavascript(script, null);
            }
        } catch (IOException e) {
            Log.w(TAG, "Script asset introuvable (" + assetPath + ") : " + e.getMessage());
        }
    }

    private static String readUtf8(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) != -1) {
            out.write(buf, 0, n);
        }
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
