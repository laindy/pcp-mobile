import Capacitor
import PhotosUI
import QuickLook
import UIKit
import UniformTypeIdentifiers
import WebKit

// MARK: - Blob file handling (save / preview)

private final class BlobFileCoordinator: NSObject, QLPreviewControllerDataSource {
    private var previewFileURL: URL?
    weak var presenter: UIViewController?

    func presentChoice(for blobURL: URL, from webView: WKWebView) {
        guard let top = Self.topViewController(base: presenter ?? webView.window?.rootViewController) else {
            return
        }

        let alert = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: "Enregistrer", style: .default) { [weak self] _ in
            self?.exportBlob(blobURL, from: webView, presenter: top, preview: false)
        })
        alert.addAction(UIAlertAction(title: "Ouvrir", style: .default) { [weak self] _ in
            self?.exportBlob(blobURL, from: webView, presenter: top, preview: true)
        })
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel))

        if let popover = alert.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }

        top.present(alert, animated: true)
    }

    private func exportBlob(_ blobURL: URL, from webView: WKWebView, presenter: UIViewController, preview: Bool) {
        fetchBlobData(blobURL, webView: webView, suggestedFilename: nil) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let fileURL):
                    if preview {
                        self.presentPreview(fileURL: fileURL, from: presenter)
                    } else {
                        self.presentShareSheet(fileURL: fileURL, from: presenter)
                    }
                case .failure(let error):
                    NSLog("[PcpDownload] blob export failed: %@", error.localizedDescription)
                    self.presentError(from: presenter)
                }
            }
        }
    }

    /// Saves a file from JS (`pcpDownloadBlob` bridge) and opens the system share sheet.
    func savePayload(
        base64: String,
        mimeType: String,
        filename: String,
        from presenter: UIViewController
    ) {
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), !data.isEmpty else {
            presentError(from: presenter)
            return
        }
        let fileURL = Self.writeDownloadData(data, mimeType: mimeType, filename: filename)
        guard let fileURL else {
            presentError(from: presenter)
            return
        }
        presentShareSheet(fileURL: fileURL, from: presenter)
    }

    private func fetchBlobData(
        _ blobURL: URL,
        webView: WKWebView,
        suggestedFilename: String?,
        completion: @escaping (Result<URL, Error>) -> Void
    ) {
        let escaped = blobURL.absoluteString
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")

        let script = """
        (async function() {
          try {
            const response = await fetch('\(escaped)');
            const blob = await response.blob();
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            const parts = String(dataUrl).split(',');
            return { base64: parts.length > 1 ? parts[1] : '', mimeType: blob.type || 'application/octet-stream' };
          } catch (e) {
            return { error: String(e) };
          }
        })()
        """

        webView.evaluateJavaScript(script) { result, error in
            if let error {
                completion(.failure(error))
                return
            }

            guard let dict = result as? [String: Any] else {
                completion(.failure(NSError(domain: "BlobDownload", code: 1)))
                return
            }

            if let jsError = dict["error"] as? String, !jsError.isEmpty {
                completion(.failure(NSError(domain: "BlobDownload", code: 2, userInfo: [NSLocalizedDescriptionKey: jsError])))
                return
            }

            guard let base64 = dict["base64"] as? String,
                  let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
                completion(.failure(NSError(domain: "BlobDownload", code: 3)))
                return
            }

            let mimeType = (dict["mimeType"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "application/octet-stream"
            let name = (dict["filename"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? suggestedFilename
            guard let fileURL = Self.writeDownloadData(data, mimeType: mimeType, filename: name ?? "document") else {
                completion(.failure(NSError(domain: "BlobDownload", code: 4)))
                return
            }
            completion(.success(fileURL))
        }
    }

    private static func safeFilename(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let invalid = CharacterSet(charactersIn: "/\\?%*|\"<>:\n\r")
        let cleaned = trimmed.components(separatedBy: invalid).joined(separator: "_")
        let base = cleaned.isEmpty ? "document" : cleaned
        return String(base.prefix(120))
    }

    private static func writeDownloadData(_ data: Data, mimeType: String, filename: String) -> URL? {
        let safe = safeFilename(filename)
        let pathExt = (safe as NSString).pathExtension
        let ext = pathExt.isEmpty ? fileExtension(for: mimeType) : pathExt
        let stem = pathExt.isEmpty ? safe : ((safe as NSString).deletingPathExtension)
        let finalName = "\(stem).\(ext)"
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(finalName)
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
            try data.write(to: fileURL, options: .atomic)
            return fileURL
        } catch {
            NSLog("[PcpDownload] write failed: %@", error.localizedDescription)
            return nil
        }
    }

    private func presentShareSheet(fileURL: URL, from presenter: UIViewController) {
        let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(activity, animated: true)
    }

    private func presentPreview(fileURL: URL, from presenter: UIViewController) {
        previewFileURL = fileURL
        let preview = QLPreviewController()
        preview.dataSource = self
        presenter.present(preview, animated: true)
    }

    private func presentError(from presenter: UIViewController) {
        let alert = UIAlertController(
            title: "Impossible d'accéder au fichier",
            message: "Réessayez dans quelques instants.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: true)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        previewFileURL == nil ? 0 : 1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        previewFileURL! as QLPreviewItem
    }

    private static func fileExtension(for mimeType: String) -> String {
        switch mimeType.lowercased() {
        case "application/pdf": return "pdf"
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png": return "png"
        case "image/webp": return "webp"
        case "text/plain": return "txt"
        default:
            if let suffix = mimeType.split(separator: "/").last, suffix != "octet-stream" {
                return String(suffix)
            }
            return "bin"
        }
    }

    private static func topViewController(base: UIViewController?) -> UIViewController? {
        if let nav = base as? UINavigationController {
            return topViewController(base: nav.visibleViewController)
        }
        if let tab = base as? UITabBarController {
            return topViewController(base: tab.selectedViewController)
        }
        if let presented = base?.presentedViewController {
            return topViewController(base: presented)
        }
        return base
    }
}

// MARK: - HealthKit session hook (équivalent Android SessionInterceptor)

/// Injecté dans la WebView après login NextAuth pour déclencher la feuille
/// système HealthKit. Sans cet appel, PCPTherapy n'apparaît jamais dans Santé.
private enum HealthSessionHook {
    static let script = """
    (function(){
      if (window.__pcpHealthHook) return;
      window.__pcpHealthHook = true;
      var PERMS = {
        read: ['steps','calories','sleep','respiratoryRate','oxygenSaturation',
               'restingHeartRate','heartRateVariability','bodyTemperature',
               'basalBodyTemperature','heartRate','mindfulness','workouts'],
        write: []
      };
      var hcAsked = false;
      var __pcpHealthAuthInFlight = false;
      var HEALTH_AUTH_ATTEMPTED_KEY = 'pcpHealthKitAuthGroupedV1';
      var lastToken = null;
      var lastRefreshToken = null;
      var __pcpSessionRole = null;
      var __pcpOnboardingDone = true;
      var __pcpLastPath = '';
      function isOnboardingPath(){
        try { return /^\\/onboarding(\\/|$)/.test(window.location.pathname || ''); }
        catch(e) { return false; }
      }
      function shouldPromptHealthKit(){
        if (__pcpSessionRole && __pcpSessionRole !== 'patient') return false;
        if (isOnboardingPath()) return false;
        if (__pcpSessionRole === 'patient' && __pcpOnboardingDone === false) return false;
        return true;
      }
      function isPatientHome(){
        try { return /\\/patient\\/home/.test(window.location.pathname || ''); }
        catch(e) { return false; }
      }
      function swipeCoachSeen(){
        try { return localStorage.getItem('pcpHealthSwipeCoachSeen') === '1'; }
        catch(e) { return true; }
      }
      function healthAuthGrantedOnce(){
        try { return localStorage.getItem('pcpHealthAuthGrantedOnce') === '1'; }
        catch(e) { return false; }
      }
      function markHealthAuthGrantedOnce(){
        try { localStorage.setItem('pcpHealthAuthGrantedOnce', '1'); } catch(e) {}
      }
      function clearHealthAuthGrantedOnce(){
        try { localStorage.removeItem('pcpHealthAuthGrantedOnce'); } catch(e) {}
      }
      function applySessionUser(user){
        if (!user) {
          __pcpSessionRole = null;
          __pcpOnboardingDone = true;
          window.__pcpHealthSyncPatientId = null;
          return;
        }
        __pcpSessionRole = user.role || null;
        __pcpOnboardingDone = user.onboardingCompleted !== false;
        if (user.id) {
          window.__pcpHealthSyncPatientId = user.id;
          if (lastToken && window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.hydrateFromNative) {
            void window.PcpHealthSyncStorage.hydrateFromNative(lastToken);
          }
        }
      }
      var PRE_AUTH_MSG = {
        fr: {
          title: 'PCPTherapy et Apple Santé',
          lead: 'Pour adapter votre suivi PCPTherapy à vos données de santé en temps réel, reliez l\\'application à Apple Santé.',
          canRead: 'PCPTherapy pourra lire',
          chips: ['Pas', 'Sommeil', 'Activités', 'HRV', 'FC repos', 'SpO₂', 'Respiration', 'Température', 'Temp. poignet'],
          hint: 'À l\\'étape suivante, activez les types listés dans la fenêtre Apple Santé (idéalement « Tout autoriser »), y compris température poignet.',
          continueBtn: 'Continuer vers Apple Santé',
          laterBtn: 'Plus tard'
        },
        en: {
          title: 'PCPTherapy and Apple Health',
          lead: 'To tailor your PCPTherapy care to your real-time health data, connect the app to Apple Health.',
          canRead: 'PCPTherapy can read',
          chips: ['Steps', 'Sleep', 'Workouts', 'HRV', 'Resting HR', 'SpO₂', 'Respiration', 'Temperature', 'Wrist temp.'],
          hint: 'On the next screen, turn on the listed data types in the Apple Health sheet (ideally « Allow all »), including wrist temperature.',
          continueBtn: 'Continue to Apple Health',
          laterBtn: 'Not now'
        }
      };
      function preAuthMsg(key){
        var loc = getAppLocale();
        var m = PRE_AUTH_MSG[loc] || PRE_AUTH_MSG.fr;
        return m[key] || PRE_AUTH_MSG.fr[key] || key;
      }
      function showPcpHealthPreAuthModal(opts){
        opts = opts || {};
        return new Promise(function(resolve){
          var existing = document.getElementById('pcp-health-preauth-overlay');
          if (existing) existing.remove();
          var overlay = document.createElement('div');
          overlay.id = 'pcp-health-preauth-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,0.45);display:flex;align-items:flex-end;justify-content:center;padding:12px;padding-bottom:calc(12px + env(safe-area-inset-bottom));box-sizing:border-box;';
          var card = document.createElement('div');
          card.style.cssText = 'width:100%;max-width:420px;background:#fff;border-radius:20px 20px 16px 16px;padding:20px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.2);font-family:system-ui,-apple-system,sans-serif;max-height:min(88vh,640px);overflow-y:auto;';
          var title = document.createElement('h2');
          title.textContent = preAuthMsg('title');
          title.style.cssText = 'margin:0 0 10px;font-size:20px;font-weight:700;color:#0f172a;line-height:1.25;';
          card.appendChild(title);
          var lead = document.createElement('p');
          lead.textContent = preAuthMsg('lead');
          lead.style.cssText = 'margin:0 0 14px;font-size:14px;line-height:1.45;color:#475569;';
          card.appendChild(lead);
          var canRead = document.createElement('p');
          canRead.textContent = preAuthMsg('canRead');
          canRead.style.cssText = 'margin:0 0 8px;font-size:13px;font-weight:600;color:#0f172a;';
          card.appendChild(canRead);
          var chipsWrap = document.createElement('div');
          chipsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;';
          var chips = PRE_AUTH_MSG[getAppLocale()] && PRE_AUTH_MSG[getAppLocale()].chips ? PRE_AUTH_MSG[getAppLocale()].chips : PRE_AUTH_MSG.fr.chips;
          chips.forEach(function(label){
            var chip = document.createElement('span');
            chip.textContent = '✓ ' + label;
            chip.style.cssText = 'display:inline-block;padding:5px 10px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px;font-weight:600;';
            chipsWrap.appendChild(chip);
          });
          card.appendChild(chipsWrap);
          var hint = document.createElement('p');
          hint.textContent = preAuthMsg('hint');
          hint.style.cssText = 'margin:0 0 16px;font-size:12px;line-height:1.4;color:#64748b;';
          card.appendChild(hint);
          var btnRow = document.createElement('div');
          btnRow.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
          var btnContinue = document.createElement('button');
          btnContinue.type = 'button';
          btnContinue.textContent = preAuthMsg('continueBtn');
          btnContinue.style.cssText = 'width:100%;padding:13px 16px;border:none;border-radius:12px;background:#1e40af;color:#fff;font-size:15px;font-weight:700;cursor:pointer;';
          var btnLater = document.createElement('button');
          btnLater.type = 'button';
          btnLater.textContent = preAuthMsg('laterBtn');
          btnLater.style.cssText = 'width:100%;padding:11px 16px;border:none;border-radius:12px;background:transparent;color:#64748b;font-size:14px;font-weight:600;cursor:pointer;';
          function closeModal(result){
            try { overlay.remove(); } catch(e) {}
            resolve(!!result);
          }
          btnContinue.addEventListener('click', function(){
            try { localStorage.setItem('pcpHealthPreAuthSeen', '1'); } catch(e) {}
            closeModal(true);
          });
          btnLater.addEventListener('click', function(){ closeModal(false); });
          overlay.addEventListener('click', function(e){ if (e.target === overlay) closeModal(false); });
          btnRow.appendChild(btnContinue);
          btnRow.appendChild(btnLater);
          card.appendChild(btnRow);
          overlay.appendChild(card);
          var root = document.body || document.documentElement;
          root.appendChild(overlay);
        });
      }
      var SETTINGS_GUIDE_MSG = {
        fr: {
          title: 'Autoriser Apple Santé',
          lead: 'La fenêtre Apple Santé ne s\\'est pas affichée ou l\\'accès a été refusé. Activez les données manuellement :',
          steps: [
            '1. Ouvrez l\\'app Santé',
            '2. Appuyez sur votre photo / Profil (coin supérieur droit)',
            '3. Apps → PCPTherapy',
            '4. Activez « Tout autoriser » (ou chaque type)',
            '5. Revenez ici et glissez à gauche pour synchroniser'
          ],
          retryBtn: 'Réessayer la fenêtre Apple Santé',
          okBtn: 'Compris'
        },
        en: {
          title: 'Allow Apple Health',
          lead: 'The Apple Health sheet did not appear or access was denied. Enable data manually:',
          steps: [
            '1. Open the Health app',
            '2. Tap your profile picture (top right)',
            '3. Apps → PCPTherapy',
            '4. Turn on « Allow all » (or each data type)',
            '5. Return here and swipe left to sync'
          ],
          retryBtn: 'Try Apple Health sheet again',
          okBtn: 'Got it'
        }
      };
      function settingsGuideMsg(key){
        var loc = getAppLocale();
        var m = SETTINGS_GUIDE_MSG[loc] || SETTINGS_GUIDE_MSG.fr;
        return m[key] || SETTINGS_GUIDE_MSG.fr[key] || key;
      }
      function showPcpHealthSettingsGuideModal(onRetry){
        return new Promise(function(resolve){
          var existing = document.getElementById('pcp-health-settings-overlay');
          if (existing) existing.remove();
          var overlay = document.createElement('div');
          overlay.id = 'pcp-health-settings-overlay';
          overlay.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(15,23,42,0.5);display:flex;align-items:flex-end;justify-content:center;padding:12px;padding-bottom:calc(12px + env(safe-area-inset-bottom));box-sizing:border-box;';
          var card = document.createElement('div');
          card.style.cssText = 'width:100%;max-width:420px;background:#fff;border-radius:20px 20px 16px 16px;padding:20px 18px 16px;box-shadow:0 12px 40px rgba(0,0,0,.2);font-family:system-ui,-apple-system,sans-serif;max-height:min(88vh,640px);overflow-y:auto;';
          var title = document.createElement('h2');
          title.textContent = settingsGuideMsg('title');
          title.style.cssText = 'margin:0 0 10px;font-size:20px;font-weight:700;color:#0f172a;line-height:1.25;';
          card.appendChild(title);
          var lead = document.createElement('p');
          lead.textContent = settingsGuideMsg('lead');
          lead.style.cssText = 'margin:0 0 14px;font-size:14px;line-height:1.45;color:#475569;';
          card.appendChild(lead);
          var stepsWrap = document.createElement('div');
          stepsWrap.style.cssText = 'margin:0 0 16px;padding:12px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;';
          var steps = SETTINGS_GUIDE_MSG[getAppLocale()] && SETTINGS_GUIDE_MSG[getAppLocale()].steps
            ? SETTINGS_GUIDE_MSG[getAppLocale()].steps : SETTINGS_GUIDE_MSG.fr.steps;
          steps.forEach(function(line){
            var p = document.createElement('p');
            p.textContent = line;
            p.style.cssText = 'margin:0 0 8px;font-size:13px;line-height:1.45;color:#334155;';
            stepsWrap.appendChild(p);
          });
          card.appendChild(stepsWrap);
          var btnRow = document.createElement('div');
          btnRow.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
          function closeGuide(retry){
            try { overlay.remove(); } catch(e) {}
            resolve(!!retry);
          }
          if (typeof onRetry === 'function') {
            var btnRetry = document.createElement('button');
            btnRetry.type = 'button';
            btnRetry.textContent = settingsGuideMsg('retryBtn');
            btnRetry.style.cssText = 'width:100%;padding:13px 16px;border:none;border-radius:12px;background:#1e40af;color:#fff;font-size:15px;font-weight:700;cursor:pointer;';
            btnRetry.addEventListener('click', function(){ closeGuide(true); });
            btnRow.appendChild(btnRetry);
          }
          var btnOk = document.createElement('button');
          btnOk.type = 'button';
          btnOk.textContent = settingsGuideMsg('okBtn');
          btnOk.style.cssText = 'width:100%;padding:11px 16px;border:none;border-radius:12px;background:transparent;color:#64748b;font-size:14px;font-weight:600;cursor:pointer;';
          btnOk.addEventListener('click', function(){ closeGuide(false); });
          btnRow.appendChild(btnOk);
          card.appendChild(btnRow);
          overlay.appendChild(card);
          var root = document.body || document.documentElement;
          root.appendChild(overlay);
        });
      }
      window.showPcpHealthPreAuthModal = showPcpHealthPreAuthModal;
      window.showPcpHealthSettingsGuideModal = showPcpHealthSettingsGuideModal;
      window.ensureHealthKitReadAccess = function(h, o){ return ensureHealthKitReadAccess(h, o); };
      function log(m){
        try {
          var line = String(m);
          console.log('[PcpHealth]', line);
          if (window.PcpHealthLogExport && window.PcpHealthLogExport.push) {
            window.PcpHealthLogExport.push(line);
          }
        } catch(e) {}
      }
      function jwtExpMs(token){
        try {
          var parts = String(token || '').split('.');
          if (parts.length < 2) return 0;
          var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
          while (b64.length % 4) b64 += '=';
          var json = JSON.parse(atob(b64));
          return (json.exp || 0) * 1000;
        } catch(e) { return 0; }
      }
      function isAccessTokenExpired(token, skewSec){
        var exp = jwtExpMs(token);
        if (!exp) return true;
        var skew = (skewSec != null ? skewSec : 90) * 1000;
        return Date.now() >= exp - skew;
      }
      async function fetchSessionTokens(){
        var res = await fetch('/api/auth/session', {
          credentials: 'include',
          cache: 'no-store'
        });
        if (!res.ok) return null;
        var data = await res.json();
        if (!data || !data.user) return null;
        return {
          accessToken: data.user.accessToken || null,
          refreshToken: data.user.refreshToken || null
        };
      }
      async function refreshAccessTokenFromRefresh(refreshToken){
        if (!refreshToken) return null;
        try {
          var res = await fetch('/api/v1/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ refresh_token: refreshToken })
          });
          if (!res.ok) {
            log('Refresh token échec HTTP ' + res.status);
            return null;
          }
          var data = await res.json();
          if (!data || !data.access_token) return null;
          lastToken = data.access_token;
          if (data.refresh_token) lastRefreshToken = data.refresh_token;
          try {
            window.dispatchEvent(new CustomEvent('pcp-health-token-refreshed', {
              detail: {
                accessToken: data.access_token,
                refreshToken: data.refresh_token || refreshToken
              }
            }));
          } catch(e) {}
          log('Access token renouvelé pour sync santé');
          return data.access_token;
        } catch(e) {
          log('Refresh token erreur: ' + e);
          return null;
        }
      }
      async function ensureFreshAccessToken(){
        var session = await fetchSessionTokens();
        if (session) {
          lastToken = session.accessToken || lastToken;
          lastRefreshToken = session.refreshToken || lastRefreshToken;
        }
        if (lastToken && !isAccessTokenExpired(lastToken)) return lastToken;
        var refreshed = await refreshAccessTokenFromRefresh(lastRefreshToken);
        if (refreshed) return refreshed;
        if (lastToken) {
          refreshed = await refreshAccessTokenFromRefresh(lastRefreshToken);
          if (refreshed) return refreshed;
        }
        return null;
      }
      /** Token pour sync manuelle : session + refresh, avec retry court si WebView pas prête. */
      async function resolveSyncAuthToken(){
        var token = await ensureFreshAccessToken();
        if (token) {
          lastToken = token;
          return token;
        }
        await new Promise(function(r){ setTimeout(r, 500); });
        token = await ensureFreshAccessToken();
        if (token) {
          lastToken = token;
          return token;
        }
        lastToken = null;
        return null;
      }
      window.__pcpPendingHealthSync = null;
      window.__pcpManualSyncLock = false;
      window.__pcpPendingManualSync = false;
      var __pcpAutoSyncTimer = null;
      /** Délai avant popin explication + feuille Santé (1er passage accueil). */
      var AUTH_PROMPT_DEFER_MS = 600;
      var AUTO_SYNC_DEFER_MS = 6000;
      /** 1ère sync auto : laisser le temps au swipe manuel avant de lancer le backfill. */
      var FIRST_AUTO_SYNC_DEFER_MS = 12000;
      var SIX_H_MS = 6 * 60 * 60 * 1000;
      function emitManualSyncFinished(detail){
        try {
          window.dispatchEvent(new CustomEvent('pcp-health-sync-finished', { detail: detail }));
        } catch(e) {}
      }
      async function maybeSyncHealth(token, force, manual, skipAuthCheck){
        var syncToken = await ensureFreshAccessToken();
        if (!syncToken) syncToken = token;
        if (!syncToken) {
          log('Sync ignorée — session expirée');
          if (manual) {
            emitManualSyncFinished({ ok: false, manual: true, reason: 'auth_expired', status: 401 });
          }
          return;
        }
        lastToken = syncToken;
        if (!window.PcpHealthIosSync) {
          log('PcpHealthIosSync absent — cap copy ios + rebuild');
          if (manual) {
            emitManualSyncFinished({ ok: false, manual: true, reason: 'no_sync_lib' });
          }
          return;
        }
        try {
          return await window.PcpHealthIosSync.run(syncToken, {
            force: !!force,
            manual: !!manual,
            skipAuthCheck: !!skipAuthCheck
          });
        } catch(e) {
          var detail = (e && e.message) ? String(e.message) : String(e);
          if (e && e.stack) { detail += ' | stack=' + String(e.stack).split('\\n').slice(0,2).join(' '); }
          log('Sync iOS erreur: ' + detail);
          if (manual) {
            emitManualSyncFinished({ ok: false, manual: true, error: detail });
          }
          return { ok: false, manual: !!manual, error: detail };
        }
      }
      function waitForSyncLib(maxMs){
        return new Promise(function(resolve){
          if (window.PcpHealthIosSync) { resolve(true); return; }
          var start = Date.now();
          var tick = function(){
            if (window.PcpHealthIosSync) { resolve(true); return; }
            if (Date.now() - start >= maxMs) { resolve(false); return; }
            setTimeout(tick, 100);
          };
          tick();
        });
      }
      function shouldRunBackgroundAutoSync(){
        var getter = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.getItem;
        var lastKey = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.LAST_DATA_SYNC_KEY;
        var last = getter && lastKey
          ? parseInt(getter(lastKey) || '0', 10)
          : parseInt(sessionStorage.getItem('pcpHealthLastDataSyncAt') || '0', 10);
        if (!last) return true;
        return (Date.now() - last) >= SIX_H_MS;
      }
      function scheduleBackgroundAutoSync(token){
        if (!token) return;
        if (!shouldPromptHealthKit()) return;
        if (!isPatientHome()) return;
        if (__pcpHealthAuthInFlight) return;
        if (window.__pcpManualSyncLock || window.__pcpHealthSyncRunning || window.__pcpHealthBackfillRunning) return;
        if (__pcpAutoSyncTimer) clearTimeout(__pcpAutoSyncTimer);
        var getter = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.getItem;
        var lastKey = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.LAST_DATA_SYNC_KEY;
        var hasPriorSync = !!(getter && lastKey ? getter(lastKey) : sessionStorage.getItem('pcpHealthLastDataSyncAt'));
        var delay = healthAuthGrantedOnce()
          ? (hasPriorSync ? AUTO_SYNC_DEFER_MS : FIRST_AUTO_SYNC_DEFER_MS)
          : AUTH_PROMPT_DEFER_MS;
        __pcpAutoSyncTimer = setTimeout(function(){
          __pcpAutoSyncTimer = null;
          if (window.__pcpManualSyncLock || window.__pcpHealthSyncRunning || window.__pcpHealthBackfillRunning) return;
          maybeAskHealthPerms(token, { autoSync: true });
        }, delay);
      }
      async function requestHealthAuthForManualSync(){
        var Health = (window.Capacitor && window.Capacitor.Plugins)
          ? window.Capacitor.Plugins.Health : null;
        if (!Health) return { granted: 0 };
        try {
          var auth = await ensureHealthKitReadAccess(Health, { force: true, manual: true });
          if (auth.requested) emitHealthAuthorizedIfNewlyGranted(0, auth.granted);
          return {
            granted: auth.granted || 0,
            requestedAuth: !!auth.requested,
            cancelled: !!auth.cancelled,
            alreadyAttempted: !!auth.alreadyAttempted
          };
        } catch(e) {
          log('Autorisation manuelle erreur: ' + e);
          return { granted: 0, error: String(e) };
        }
      }
      async function promptHealthAccessAfterFailure(){
        clearHealthAuthSheetAttempted();
        clearHealthAuthGrantedOnce();
        var Health = (window.Capacitor && window.Capacitor.Plugins)
          ? window.Capacitor.Plugins.Health : null;
        if (!Health) return 0;
        log('Nouvelle tentative — popin explication + feuille Apple Santé…');
        var auth = await ensureHealthKitReadAccess(Health, { force: true, manual: true });
        if (auth.granted > 0) {
          emitHealthAuthorizedIfNewlyGranted(0, auth.granted);
          return auth.granted;
        }
        await showPcpHealthSettingsGuideModal(false);
        return 0;
      }
      async function runManualHealthSync(){
        if (shouldShowBackfillBusyToast()) {
          log('sync manuelle ignorée — import historique en cours (bandeau visible)');
          window.__pcpPendingManualSync = true;
          showBackfillBusyToast();
          return;
        }
        if (window.__pcpManualSyncLock) {
          log('sync manuelle ignorée — déjà en cours');
          window.__pcpPendingManualSync = true;
          showSyncToast(syncMsg('syncing'), { persist: true });
          return;
        }
        if (__pcpAutoSyncTimer) {
          clearTimeout(__pcpAutoSyncTimer);
          __pcpAutoSyncTimer = null;
        }
        window.__pcpManualSyncLock = true;
        try {
          var prefetch = window.__pcpSwipeAuthPrefetch;
          window.__pcpSwipeAuthPrefetch = null;
          var syncToken = prefetch ? await prefetch : null;
          if (!syncToken) syncToken = await resolveSyncAuthToken();
          if (!syncToken) {
            log('sync manuelle ignorée — session absente ou expirée');
            emitManualSyncFinished({ ok: false, manual: true, reason: 'auth_expired', status: 401 });
            return;
          }
          clearHealthAuthSheetAttempted();
          var authResult = await requestHealthAuthForManualSync();
          var granted = authResult && authResult.granted ? authResult.granted : 0;
          if (authResult && authResult.cancelled) {
            log('Sync manuelle annulée — explication Santé refusée');
            emitManualSyncFinished({ ok: false, manual: true, reason: 'health_auth_cancelled' });
            return;
          }
          if (!granted) {
            log('Sync manuelle annulée — Santé non autorisé (modale réglages)');
            granted = await promptHealthAccessAfterFailure();
            if (!granted) {
              emitManualSyncFinished({ ok: false, manual: true, reason: 'no_health_auth' });
              return;
            }
          }
          var libReady = await waitForSyncLib(5000);
          if (!libReady || !window.PcpHealthIosSync) {
            log('sync manuelle — lib iOS absente (timeout injection)');
            showSyncToast(syncMsg('error_nolib'), { error: true });
            emitManualSyncFinished({ ok: false, manual: true, reason: 'no_sync_lib' });
            return;
          }
          syncToken = await ensureFreshAccessToken() || syncToken;
          if (!syncToken) {
            emitManualSyncFinished({ ok: false, manual: true, reason: 'auth_expired', status: 401 });
            return;
          }
          lastToken = syncToken;
          if (shouldShowBackfillBusyToast()) {
            window.__pcpPendingManualSync = true;
            showBackfillBusyToast();
            return;
          }
          showSyncToast(syncMsg('syncing'), { persist: true });
          var syncResult = await maybeSyncHealth(syncToken, true, true, true);
          if (syncResult && syncResult.skipped && syncResult.reason === 'busy') {
            log('Sync manuelle mise en file — sync auto déjà en cours');
            if (shouldShowBackfillBusyToast()) showBackfillBusyToast();
          }
        } catch(e) {
          log('runManualHealthSync erreur: ' + e);
          emitManualSyncFinished({ ok: false, manual: true, error: String(e) });
          showSyncToast(formatSyncError({ error: String(e) }), { error: true });
        } finally {
          window.__pcpManualSyncLock = false;
          if (
            window.__pcpPendingManualSync &&
            !window.__pcpHealthSyncRunning &&
            !window.__pcpHealthBackfillRunning
          ) {
            window.__pcpPendingManualSync = false;
            log('Sync manuelle en attente ignorée — aucune sync active (réessayez le swipe)');
          }
        }
      }
      window.__pcpHealthSyncStateResolve = function(requestId, payload){
        var cb = window.__pcpSyncStateCallbacks && window.__pcpSyncStateCallbacks[requestId];
        if (cb) {
          delete window.__pcpSyncStateCallbacks[requestId];
          cb(payload);
        }
      };
      function postNativeSyncState(message){
        var handler = window.webkit && window.webkit.messageHandlers
          && window.webkit.messageHandlers.pcpHealthSyncState;
        if (handler) handler.postMessage(message);
      }
      window.__pcpHealthOnSyncLibReady = function(){
        if (lastToken && window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.hydrateFromNative) {
          void window.PcpHealthSyncStorage.hydrateFromNative(lastToken).then(function(){
            if (window.PcpHealthSyncIndicator && window.PcpHealthSyncIndicator.sync) {
              window.PcpHealthSyncIndicator.sync();
            }
          });
        }
        var p = window.__pcpPendingHealthSync;
        if (!p || !window.PcpHealthIosSync) return;
        if (window.__pcpManualSyncLock) return;
        window.__pcpPendingHealthSync = null;
        window.PcpHealthIosSync.run(p.token, { force: p.force, manual: !!p.manual });
      };
      async function countHealthReadGranted(Health){
        var status = await Health.checkAuthorization(PERMS);
        return (status && status.readAuthorized) ? status.readAuthorized.length : 0;
      }
      async function countHealthReadGrantedWithRetry(Health, maxRetries){
        var tries = (maxRetries != null && maxRetries >= 0) ? maxRetries : 0;
        var n = 0;
        for (var i = 0; i <= tries; i++) {
          n = await countHealthReadGranted(Health);
          if (n > 0) return n;
          if (i < tries) {
            await new Promise(function(r){ setTimeout(r, 450 * (i + 1)); });
          }
        }
        return n;
      }
      function healthAuthSheetAlreadyAttempted(){
        try { return sessionStorage.getItem(HEALTH_AUTH_ATTEMPTED_KEY) === '1'; }
        catch(e) { return false; }
      }
      function markHealthAuthSheetAttempted(){
        hcAsked = true;
        try { sessionStorage.setItem(HEALTH_AUTH_ATTEMPTED_KEY, '1'); } catch(e) {}
      }
      function clearHealthAuthSheetAttempted(){
        hcAsked = false;
        try { sessionStorage.removeItem(HEALTH_AUTH_ATTEMPTED_KEY); } catch(e) {}
      }
      /** Une seule feuille iOS : tous les types (Capgo + température poignet Watch). */
      function requestAllHealthKitReadNative(){
        return new Promise(function(resolve){
          var handler = window.webkit && window.webkit.messageHandlers
            && window.webkit.messageHandlers.pcpHealthRequestAllReadAuthorization;
          if (!handler) { resolve(false); return; }
          var requestId = 'auth|' + Date.now();
          window.__pcpHealthAuthCallbacks = window.__pcpHealthAuthCallbacks || {};
          var timer = window.setTimeout(function(){
            delete window.__pcpHealthAuthCallbacks[requestId];
            resolve(false);
          }, 120000);
          window.__pcpHealthAuthCallbacks[requestId] = function(ok){
            window.clearTimeout(timer);
            resolve(!!ok);
          };
          try { handler.postMessage({ requestId: requestId }); }
          catch(e) {
            window.clearTimeout(timer);
            delete window.__pcpHealthAuthCallbacks[requestId];
            resolve(false);
          }
        });
      }
      window.__pcpHealthAuthResolve = function(requestId, ok){
        var cb = window.__pcpHealthAuthCallbacks && window.__pcpHealthAuthCallbacks[requestId];
        if (cb) {
          delete window.__pcpHealthAuthCallbacks[requestId];
          cb(!!ok);
        }
      };
      window.__pcpNativeAuthCheckCallbacks = window.__pcpNativeAuthCheckCallbacks || {};
      window.__pcpNativeAuthCheckResolve = function(requestId, payload){
        var cb = window.__pcpNativeAuthCheckCallbacks && window.__pcpNativeAuthCheckCallbacks[requestId];
        if (cb) {
          delete window.__pcpNativeAuthCheckCallbacks[requestId];
          cb(payload || {});
        }
      };
      /** VO₂ max + temp. poignet : absents de Capgo iOS — statut via pont natif. */
      function checkNativeOnlyTypesPending(){
        return new Promise(function(resolve){
          var handler = window.webkit && window.webkit.messageHandlers
            && window.webkit.messageHandlers.pcpHealthCheckNativeOnlyAuth;
          if (!handler) { resolve({ needsAuth: false, pending: {} }); return; }
          var requestId = 'nativeAuthCheck|' + Date.now();
          window.__pcpNativeAuthCheckCallbacks[requestId] = function(payload){
            resolve(payload || { needsAuth: false, pending: {} });
          };
          var timer = window.setTimeout(function(){
            delete window.__pcpNativeAuthCheckCallbacks[requestId];
            resolve({ needsAuth: false, pending: {}, timeout: true });
          }, 5000);
          var wrapped = window.__pcpNativeAuthCheckCallbacks[requestId];
          window.__pcpNativeAuthCheckCallbacks[requestId] = function(payload){
            window.clearTimeout(timer);
            wrapped(payload);
          };
          try { handler.postMessage({ requestId: requestId }); }
          catch(e) {
            window.clearTimeout(timer);
            delete window.__pcpNativeAuthCheckCallbacks[requestId];
            resolve({ needsAuth: false, pending: {} });
          }
        });
      }
      function describeNativePending(pending){
        var labels = [];
        if (pending && pending.vo2Max) labels.push('VO₂ max');
        if (pending && pending.appleSleepingWristTemperature) labels.push('temp. poignet');
        return labels.join(', ');
      }
      /**
       * Feuille Apple groupée (natif) = tous les types HK dont Capgo ne gère pas VO₂ / poignet.
       * Capgo est rappelé ensuite pour aligner checkAuthorization du plugin.
       */
      async function ensureHealthKitReadAccess(Health, opts){
        opts = opts || {};
        var force = !!(opts.force || opts.manual);
        var before = await countHealthReadGrantedWithRetry(Health, 1);
        if (before === 0) clearHealthAuthGrantedOnce();
        var nativeCheck = await checkNativeOnlyTypesPending();
        var nativePending = !!(nativeCheck && nativeCheck.needsAuth);
        var pendingLabels = describeNativePending(nativeCheck && nativeCheck.pending);
        if (before > 0 && !nativePending) {
          markHealthAuthGrantedOnce();
          return { granted: before, requested: false };
        }
        if (before > 0 && nativePending) {
          log('Capgo OK (' + before + ' types) — feuille native requise: ' + pendingLabels);
          clearHealthAuthSheetAttempted();
        }
        if (__pcpHealthAuthInFlight) {
          log('Autorisation Santé déjà en cours — ignoré');
          return { granted: before || 0, inFlight: true, nativePending: nativePending };
        }
        if (!force && !nativePending && (healthAuthSheetAlreadyAttempted() || hcAsked)) {
          var retry = await countHealthReadGrantedWithRetry(Health, 4);
          if (retry > 0) {
            markHealthAuthGrantedOnce();
            return { granted: retry, requested: false };
          }
          if (opts.fromHome || force) {
            log('Nouvelle proposition feuille Santé (accueil / swipe)…');
            clearHealthAuthSheetAttempted();
          } else {
            log('Feuille Santé déjà proposée — pas de 2e demande (swipe manuel pour rouvrir)');
            return { granted: 0, alreadyAttempted: true };
          }
        }
        if (nativePending && !force && !opts.fromHome && !opts.manual) {
          log('Types natifs manquants (' + pendingLabels + ') — swipe pour rouvrir Santé');
          return { granted: before || 0, requested: false, nativePending: true };
        }
        __pcpHealthAuthInFlight = true;
        try {
          if (!opts.skipPreAuth) {
            log('Affichage popin explication Apple Santé…');
            var proceed = await showPcpHealthPreAuthModal({});
            if (!proceed) return { granted: before || 0, cancelled: true, nativePending: nativePending };
          }
          markHealthAuthSheetAttempted();
          log('Demande permissions HealthKit (feuille native groupée — incl. ' + (pendingLabels || 'VO₂ max, temp. poignet') + ')…');
          var nativeOk = await requestAllHealthKitReadNative();
          if (!nativeOk) {
            log('Repli Capgo requestAuthorization (build sans auth native groupée)');
          }
          try {
            await Health.requestAuthorization(PERMS);
          } catch(e) {
            log('Capgo requestAuthorization erreur: ' + e);
          }
          await new Promise(function(r){ setTimeout(r, 800); });
          var after = await countHealthReadGrantedWithRetry(Health, 5);
          if (after > 0) markHealthAuthGrantedOnce();
          if (after === 0 && !nativePending) {
            clearHealthAuthSheetAttempted();
            clearHealthAuthGrantedOnce();
          }
          var stillPending = await checkNativeOnlyTypesPending();
          if (stillPending && stillPending.needsAuth) {
            log('Après feuille Santé — encore manquant: ' + describeNativePending(stillPending.pending));
          }
          return {
            granted: after || before || 0,
            requested: true,
            before: before,
            nativeOk: nativeOk,
            nativePending: !!(stillPending && stillPending.needsAuth)
          };
        } finally {
          __pcpHealthAuthInFlight = false;
        }
      }
      function emitHealthAuthorizedIfNewlyGranted(beforeCount, afterCount){
        if (afterCount > 0) markHealthAuthGrantedOnce();
        if (afterCount > 0 && beforeCount === 0) {
          try {
            window.dispatchEvent(new CustomEvent('pcp-health-authorized', { detail: { granted: afterCount } }));
          } catch(e) {}
        }
      }
      async function maybeAskHealthPerms(token, opts){
        opts = opts || {};
        try {
          if (!shouldPromptHealthKit()) return;
          if (opts.autoSync && !isPatientHome()) return;
          if (__pcpHealthAuthInFlight) return;
          if (window.__pcpManualSyncLock || window.__pcpHealthSyncRunning) return;
          var Health = (window.Capacitor && window.Capacitor.Plugins)
            ? window.Capacitor.Plugins.Health : null;
          if (!Health) return;
          var avail = await Health.isAvailable();
          if (!avail || !avail.available) {
            log('HealthKit indisponible: ' + (avail && avail.reason ? avail.reason : 'unknown'));
            return;
          }
          var granted = await countHealthReadGrantedWithRetry(Health, 1);
          if (granted === 0) {
            clearHealthAuthSheetAttempted();
            log('Flux consentement Santé (popin + feuille iOS)…');
            var auth = await ensureHealthKitReadAccess(Health, { fromHome: true });
            if (auth.cancelled || auth.inFlight) {
              log('Autorisation Santé reportée (après onboarding)');
              return;
            }
            if (auth.requested) emitHealthAuthorizedIfNewlyGranted(0, auth.granted);
            granted = auth.granted || 0;
            if (auth.requested && granted === 0 && opts.autoSync) {
              setTimeout(function(){ scheduleBackgroundAutoSync(token); }, 4000);
            }
          } else {
            log('HealthKit autorisé (' + granted + ' types)');
            markHealthAuthGrantedOnce();
            var nativeCheck = await checkNativeOnlyTypesPending();
            if (nativeCheck && nativeCheck.needsAuth) {
              log('Types natifs manquants (' + describeNativePending(nativeCheck.pending) + ') — feuille groupée…');
              var authNative = await ensureHealthKitReadAccess(Health, { fromHome: true, force: true });
              if (authNative.requested) emitHealthAuthorizedIfNewlyGranted(granted, authNative.granted || granted);
            }
            if (opts.autoSync && !swipeCoachSeen() && window.tryShowSwipeCoachAfterAuth) {
              window.tryShowSwipeCoachAfterAuth();
            }
          }
          if (!opts.autoSync || granted === 0 || !token) return;
          if (!shouldRunBackgroundAutoSync()) return;
          var forceSync = !(window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.getItem
            ? window.PcpHealthSyncStorage.getItem(window.PcpHealthSyncStorage.LAST_DATA_SYNC_KEY)
            : sessionStorage.getItem('pcpHealthLastDataSyncAt'));
          if (window.PcpHealthIosSync) {
            await maybeSyncHealth(token, forceSync, false);
          } else if (!window.__pcpPendingHealthSync) {
            window.__pcpPendingHealthSync = { token: token, force: !!forceSync, manual: false };
            log('Sync iOS en attente injection native (bundle)');
          }
        } catch(e) {
          log('HealthKit perms erreur: ' + e);
        }
      }
      async function pollSession(){
        try {
          var res = await fetch('/api/auth/session', {
            credentials: 'include',
            cache: 'no-store'
          });
          if (!res.ok) return;
          var data = await res.json();
          applySessionUser(data && data.user ? data.user : null);
          var token = (data && data.user) ? data.user.accessToken : null;
          var refresh = (data && data.user) ? data.user.refreshToken : null;
          if (token) {
            lastToken = token;
            if (refresh) lastRefreshToken = refresh;
            if (shouldPromptHealthKit()) scheduleBackgroundAutoSync(token);
          } else {
            lastToken = null;
            lastRefreshToken = null;
          }
        } catch(e) { /* page en transit */ }
      }
      function watchRouteForHealthPrompt(){
        try {
          var path = window.location.pathname || '';
          if (path === __pcpLastPath) return;
          __pcpLastPath = path;
          if (!lastToken || !shouldPromptHealthKit()) return;
          if (/^\\/patient\\/home/.test(path)) {
            log('Arrivée accueil patient — programmation consentement Santé');
            scheduleBackgroundAutoSync(lastToken);
            if (window.__pcpSwipeCoachPending && window.tryShowSwipeCoachAfterAuth) {
              window.tryShowSwipeCoachAfterAuth();
            }
          }
        } catch(e) {}
      }
      function isIosApp(){
        try {
          return window.Capacitor && window.Capacitor.getPlatform &&
            window.Capacitor.getPlatform() === 'ios';
        } catch(e) { return false; }
      }
      function getAppLocale(){
        try {
          var match = document.cookie.match(/(?:^|;\\s*)locale=([^;]+)/);
          if (match && match[1]) return match[1].indexOf('en') === 0 ? 'en' : 'fr';
          var htmlLang = document.documentElement && document.documentElement.lang;
          if (htmlLang && htmlLang.indexOf('en') === 0) return 'en';
        } catch(e) {}
        return 'fr';
      }
      var SYNC_MSG = {
        fr: {
          syncing: 'Synchronisation en cours…',
          success: 'Données santé synchronisées',
          backfill_in_progress: 'Données récentes OK — import historique (60 j) en cours…',
          backfill_complete: 'Historique santé synchronisé',
          error: 'Échec de la synchronisation',
          recent: 'Synchronisation récente — réessayez plus tard',
          pull: 'Glissez vers la gauche pour synchroniser',
          release: 'Relâchez pour synchroniser',
          perms: 'Autorisez l\\'accès à Santé pour synchroniser',
          perms_settings: 'Ouvrez Santé → Profil → Apps → PCPTherapy et activez toutes les données, puis resynchronisez',
          perms_short: 'Accès Santé requis — voir les instructions à l\\'écran',
          error_notoken: 'Connectez-vous pour synchroniser',
          error_nolib: 'Mise à jour de l\\'app requise — réinstallez depuis TestFlight',
          error_busy: 'Synchronisation déjà en cours',
          error_network: 'Échec réseau — réessayez (Wi‑Fi stable, attendez la fin de la sync)',
          error_payload: 'Envoi trop lourd — relancez le swipe, l’app enverra en plusieurs lots',
          error_session: 'Session expirée — reconnectez-vous',
          empty_no_data: 'Aucune donnée Santé à synchroniser',
          shareLogs: 'Envoyer les logs',
          shareLogsSent: 'Choisissez Mail ou Messages pour envoyer le rapport'
        },
        en: {
          syncing: 'Syncing…',
          success: 'Health data synced',
          backfill_in_progress: 'Recent data OK — importing history (60 days)…',
          backfill_complete: 'Health history synced',
          error: 'Sync failed',
          recent: 'Recently synced — try again later',
          pull: 'Swipe left to sync',
          release: 'Release to sync',
          perms: 'Allow Health access to sync your data',
          perms_settings: 'Open Health → Profile → Apps → PCPTherapy, enable all data types, then sync again',
          perms_short: 'Health access required — see on-screen instructions',
          error_notoken: 'Sign in to sync',
          error_nolib: 'App update required — reinstall from TestFlight',
          error_busy: 'Sync already in progress',
          error_network: 'Network error — try again (stable Wi‑Fi, wait for sync to finish)',
          error_payload: 'Upload too large — swipe again; the app will send in batches',
          error_session: 'Session expired — sign in again',
          empty_no_data: 'No Health data to sync',
          shareLogs: 'Send logs',
          shareLogsSent: 'Choose Mail or Messages to send the report'
        }
      };
      function syncMsg(key){
        var loc = getAppLocale();
        return (SYNC_MSG[loc] && SYNC_MSG[loc][key]) || SYNC_MSG.fr[key] || key;
      }
      function formatSyncError(d){
        if (!d) return syncMsg('error');
        if (d.reason === 'no_health_auth') return syncMsg('perms_short');
        if (d.reason === 'no_sync_lib') return syncMsg('error_nolib');
        if (d.reason === 'busy') return syncMsg('error_busy');
        if (d.reason === 'auth_expired') return syncMsg('error_session');
        if (d.reason === 'no_data') return syncMsg('empty_no_data');
        if (d.status === 401 || (d.error && String(d.error).toLowerCase().indexOf('credential') >= 0)) {
          return syncMsg('error_session');
        }
        if (d.error) {
          var err = String(d.error);
          if (/load failed/i.test(err)) {
            if (/body≈|trop gros|volumineux/i.test(err)) return syncMsg('error_payload');
            return syncMsg('error_network');
          }
          return syncMsg('error') + ' — ' + err.slice(0, 90);
        }
        if (d.status === 500) return syncMsg('error') + ' (serveur — voir logs)';
        if (d.status) return syncMsg('error') + ' (HTTP ' + d.status + ')';
        if (d.body && d.body.detail) {
          var det = d.body.detail;
          if (typeof det === 'string') return syncMsg('error') + ' — ' + det.slice(0, 90);
          try { return syncMsg('error') + ' — ' + JSON.stringify(det).slice(0, 90); } catch(e) {}
        }
        return syncMsg('error');
      }
      function triggerSyncHaptic(){
        try {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pcpHealthHaptic) {
            window.webkit.messageHandlers.pcpHealthHaptic.postMessage('medium');
          }
        } catch(e) {}
      }
      window.triggerPcpHealthHaptic = triggerSyncHaptic;
      window.__pcpWristTempCallbacks = window.__pcpWristTempCallbacks || {};
      window.__pcpWristTempResolve = function(requestId, payload){
        var cb = window.__pcpWristTempCallbacks[requestId];
        if (cb) {
          delete window.__pcpWristTempCallbacks[requestId];
          cb(payload);
        }
      };
      window.__pcpVo2MaxCallbacks = window.__pcpVo2MaxCallbacks || {};
      window.__pcpVo2MaxResolve = function(requestId, payload){
        var cb = window.__pcpVo2MaxCallbacks[requestId];
        if (cb) {
          delete window.__pcpVo2MaxCallbacks[requestId];
          cb(payload);
        }
      };
      window.__pcpWorkoutsCallbacks = window.__pcpWorkoutsCallbacks || {};
      window.__pcpWorkoutsResolve = function(requestId, payload){
        var cb = window.__pcpWorkoutsCallbacks[requestId];
        if (cb) {
          delete window.__pcpWorkoutsCallbacks[requestId];
          cb(payload);
        }
      };
      if (isIosApp() && !window.PcpHealthBridge) {
        window.PcpHealthBridge = {
          triggerSync: function(){
            runManualHealthSync();
          },
          ensureAccessToken: function(){ return resolveSyncAuthToken(); },
          refreshAccessToken: function(){ return refreshAccessTokenFromRefresh(lastRefreshToken); },
          hasToken: function(){ return !!lastToken; },
          getLastSyncInfo: function(){
            var getter = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.getItem;
            var syncKey = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.LAST_DATA_SYNC_KEY;
            var scoped = getter && syncKey ? getter(syncKey) : null;
            return JSON.stringify({
              lastSyncAt: parseInt(scoped || sessionStorage.getItem('pcpHealthLastDataSyncAt') || sessionStorage.getItem('pcpHealthLastSyncAt') || '0', 10),
              hasToken: !!lastToken
            });
          },
          getFullBackfillAt: function(){
            var getter = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.getItem;
            var key = window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.FULL_BACKFILL_KEY;
            return getter && key ? parseInt(getter(key, lastToken) || '0', 10) : 0;
          },
          markServerBackfillComplete: function(ts){
            if (!window.PcpHealthSyncStorage || !window.PcpHealthSyncStorage.setItem) return;
            window.PcpHealthSyncStorage.setItem(
              window.PcpHealthSyncStorage.FULL_BACKFILL_KEY,
              String(ts || Date.now()),
              lastToken
            );
          },
          getSyncScopedState: function(patientId){
            return new Promise(function(resolve){
              if (!patientId) { resolve(null); return; }
              var requestId = 'syncState_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
              window.__pcpSyncStateCallbacks = window.__pcpSyncStateCallbacks || {};
              window.__pcpSyncStateCallbacks[requestId] = resolve;
              postNativeSyncState({ action: 'get', patientId: patientId, requestId: requestId });
              setTimeout(function(){
                if (window.__pcpSyncStateCallbacks && window.__pcpSyncStateCallbacks[requestId]) {
                  delete window.__pcpSyncStateCallbacks[requestId];
                  resolve(null);
                }
              }, 3000);
            });
          },
          setSyncScopedState: function(patientId, key, value){
            if (!patientId || !key) return;
            postNativeSyncState({ action: 'set', patientId: patientId, key: key, value: value || '' });
          },
          shareSyncLogs: async function(){
            try {
              if (!window.PcpHealthLogExport || !window.PcpHealthLogExport.share) {
                showSyncToast(syncMsg('error_nolib'), { error: true });
                return;
              }
              var result = await window.PcpHealthLogExport.share();
              if (result && result.ok) {
                showSyncToast(syncMsg('shareLogsSent'));
              } else {
                showSyncToast(syncMsg('error'), { error: true });
              }
            } catch(e) {
              showSyncToast(syncMsg('error'), { error: true });
            }
          }
        };
      }
      var __pcpLogShareNavPath = null;
      var __pcpLogShareNavHideTimer = null;
      var LOG_SHARE_NAV_HIDE_MS = 4000;
      function installLogShareNavDismiss(){
        if (window.__pcpLogShareNavDismiss) return;
        window.__pcpLogShareNavDismiss = true;
        setInterval(function(){
          try {
            var path = window.location.pathname || '';
            if (__pcpLogShareNavPath == null) {
              __pcpLogShareNavPath = path;
              return;
            }
            if (path === __pcpLogShareNavPath) return;
            __pcpLogShareNavPath = path;
            var el = document.getElementById('pcp-health-log-share-btn');
            if (!el || el.style.display === 'none') return;
            clearTimeout(__pcpLogShareNavHideTimer);
            __pcpLogShareNavHideTimer = setTimeout(function(){
              __pcpLogShareNavHideTimer = null;
              hideLogSharePrompt();
            }, LOG_SHARE_NAV_HIDE_MS);
          } catch(e) {}
        }, 700);
      }
      function hideLogSharePrompt(){
        clearTimeout(__pcpLogShareNavHideTimer);
        __pcpLogShareNavHideTimer = null;
        var el = document.getElementById('pcp-health-log-share-btn');
        if (el) el.style.display = 'none';
      }
      function showLogSharePrompt(){
        if (window.__pcpBackfillBannerVisible || isBackfillUiActive()) {
          window.__pcpDeferLogShareUntilBackfill = true;
          return;
        }
        if (!window.PcpHealthLogExport) return;
        installLogShareNavDismiss();
        var id = 'pcp-health-log-share-btn';
        var el = document.getElementById(id);
        if (!el) {
          el = document.createElement('button');
          el.id = id;
          el.type = 'button';
          el.style.cssText = 'position:fixed;bottom:calc(72px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);z-index:99999;padding:10px 16px;border-radius:999px;border:none;background:#1e40af;color:#fff;font:600 13px system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.22);cursor:pointer;max-width:min(calc(100vw - 24px), 340px);';
          el.addEventListener('click', function(){
            if (window.PcpHealthBridge && window.PcpHealthBridge.shareSyncLogs) {
              window.PcpHealthBridge.shareSyncLogs();
            } else if (window.PcpHealthLogExport && window.PcpHealthLogExport.share) {
              window.PcpHealthLogExport.share();
            }
          });
          document.body.appendChild(el);
        }
        el.textContent = syncMsg('shareLogs');
        el.style.display = 'block';
        window.__pcpDeferLogShareUntilBackfill = false;
        clearTimeout(__pcpLogShareNavHideTimer);
        __pcpLogShareNavHideTimer = null;
        try { __pcpLogShareNavPath = window.location.pathname || ''; } catch(e) {}
      }
      function showSyncToast(message, options){
        try {
          if (document.body && document.body.dataset && document.body.dataset.pcpHealthSwipe === 'frontend') return;
          var opts = (typeof options === 'boolean') ? { error: !!options } : (options || {});
          var id = 'pcp-health-sync-toast';
          var el = document.getElementById(id);
          if (!el) {
            el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
          }
          el.style.position = 'fixed';
          el.style.left = '50%';
          el.style.right = 'auto';
          el.style.bottom = 'calc(20px + env(safe-area-inset-bottom))';
          el.style.transform = 'translateX(-50%)';
          el.style.zIndex = '99999';
          el.style.display = 'inline-block';
          el.style.width = 'max-content';
          el.style.maxWidth = 'min(calc(100vw - 24px), 340px)';
          el.style.boxSizing = 'border-box';
          el.style.padding = '10px 14px';
          el.style.borderRadius = '999px';
          el.style.textAlign = 'center';
          el.style.whiteSpace = 'normal';
          el.style.font = '600 13px/1.35 system-ui,-apple-system,sans-serif';
          el.style.boxShadow = '0 8px 24px rgba(0,0,0,0.18)';
          el.style.pointerEvents = 'none';
          el.style.transition = 'opacity .2s ease';
          el.textContent = message;
          el.style.color = '#fff';
          el.style.opacity = '1';
          if (opts.error) {
            el.style.background = 'rgba(220,38,38,0.95)';
          } else if (opts.warn) {
            el.style.background = 'rgba(180,83,9,0.94)';
          } else if (opts.persist) {
            el.style.background = 'rgba(30,64,175,0.94)';
          } else {
            el.style.background = 'rgba(15,23,42,0.92)';
          }
          clearTimeout(el.__pcpHideTimer);
          window.__pcpSyncToastPersist = !!opts.persist;
          if (opts.persist) return;
          var hideMs = typeof opts.durationMs === 'number'
            ? opts.durationMs
            : (opts.error ? 4500 : (opts.warn ? 2200 : 3000));
          el.__pcpHideTimer = setTimeout(function(){
            el.style.opacity = '0';
            window.__pcpSyncToastPersist = false;
          }, hideMs);
        } catch(e) {}
      }
      function dismissSyncToast(){
        try {
          var el = document.getElementById('pcp-health-sync-toast');
          if (el) {
            clearTimeout(el.__pcpHideTimer);
            el.style.opacity = '0';
            el.style.display = 'none';
          }
          window.__pcpSyncToastPersist = false;
        } catch(e) {}
      }
      function shouldShowBackfillBusyToast(){
        return window.__pcpBackfillBannerVisible === true || window.__pcpHealthBackfillRunning === true;
      }
      function showBackfillBusyToast(){
        dismissSyncToast();
        showSyncToast(syncMsg('error_busy'), { warn: true, durationMs: 1600 });
      }
      function showFinalToastAfterBackfill(){
        var kind = window.__pcpPendingFinalToast;
        window.__pcpPendingFinalToast = null;
        if (kind === 'success') {
          showSyncToast(syncMsg('success'));
        } else if (kind === 'error') {
          showSyncToast(syncMsg('error'), { error: true });
        }
      }
      var __pcpBackfillBannerSince = 0;
      var __pcpBackfillBannerHideTimer = null;
      var BACKFILL_BANNER_MIN_MS = 12000;
      function isBackfillUiActive(){
        if (window.__pcpHealthBackfillRunning) return true;
        try {
          if (window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.isFullBackfillComplete) {
            if (window.PcpHealthSyncStorage.isFullBackfillComplete()) return false;
          }
          if (window.PcpHealthSyncStorage && window.PcpHealthSyncStorage.isBackfillPending) {
            return window.PcpHealthSyncStorage.isBackfillPending();
          }
        } catch(e) {}
        return false;
      }
      function shouldShowBackfillBanner(){
        return isBackfillUiActive();
      }
      function showBackfillBanner(opts){
        try {
          var options = opts || {};
          if (!options.forceError && !shouldShowBackfillBanner()) return;
          if (document.body && document.body.dataset && document.body.dataset.pcpHealthSwipe === 'frontend') return;
          hideLogSharePrompt();
          __pcpBackfillBannerSince = Date.now();
          window.__pcpBackfillBannerVisible = true;
          window.__pcpBackfillBannerError = !!options.forceError;
          clearTimeout(__pcpBackfillBannerHideTimer);
          var id = 'pcp-health-backfill-banner';
          var el = document.getElementById(id);
          if (!el) {
            el = document.createElement('div');
            el.id = id;
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.style.cssText = 'position:fixed;bottom:calc(72px + env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);z-index:99999;pointer-events:none;max-width:min(calc(100vw - 24px), 340px);width:max-content;box-sizing:border-box;display:none';
            el.innerHTML = '<div style="display:flex;align-items:flex-start;gap:8px;padding:10px 14px;border-radius:16px;background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;box-shadow:0 8px 24px rgba(30,64,175,.32);font:600 12px/1.35 system-ui,-apple-system,sans-serif;text-align:left"><span id="pcp-backfill-dot" style="flex:0 0 auto;width:8px;height:8px;margin-top:4px;border-radius:50%;background:#93c5fd;box-shadow:0 0 0 3px rgba(147,197,253,.35);animation:pcpBackfillDot 1.6s ease-in-out infinite"></span><span style="flex:1;min-width:0"><span id="pcp-health-backfill-banner-title" style="display:block;font-size:13px"></span><span id="pcp-health-backfill-banner-sub" style="display:block;margin-top:2px;font-weight:500;font-size:11px;opacity:.9"></span></span></div>';
            if (!document.getElementById('pcp-backfill-banner-style')) {
              var st = document.createElement('style');
              st.id = 'pcp-backfill-banner-style';
              st.textContent = '@keyframes pcpBackfillDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(.88)}}';
              document.head.appendChild(st);
            }
            document.body.appendChild(el);
          }
          var loc = getAppLocale();
          var titleFr = options.forceError
            ? 'Import historique interrompu'
            : 'Import historique en cours';
          var subFr = options.forceError
            ? 'Glissez à gauche sur l\\'accueil pour reprendre'
            : '7 j synchronisés — récupération jusqu\\'à 60 j';
          var titleEn = options.forceError
            ? 'History import interrupted'
            : 'History import in progress';
          var subEn = options.forceError
            ? 'Swipe left on Home to resume'
            : '7 days synced — fetching up to 60 days';
          var titleEl = document.getElementById('pcp-health-backfill-banner-title');
          var subEl = document.getElementById('pcp-health-backfill-banner-sub');
          if (titleEl) titleEl.textContent = loc === 'en' ? titleEn : titleFr;
          if (subEl) subEl.textContent = loc === 'en' ? subEn : subFr;
          el.style.display = 'block';
          dismissSyncToast();
          log('[UI] Bandeau import historique affiché (emplacement logs) — toast sync masqué');
        } catch(e) {}
      }
      function hideBackfillBanner(force){
        try {
          if (isBackfillUiActive() && !force) {
            showBackfillBanner();
            return;
          }
          if (!window.__pcpBackfillBannerVisible && !__pcpBackfillBannerHideTimer && !force) return;
          var elapsed = __pcpBackfillBannerSince ? (Date.now() - __pcpBackfillBannerSince) : BACKFILL_BANNER_MIN_MS;
          var wait = force ? 0 : Math.max(0, BACKFILL_BANNER_MIN_MS - elapsed);
          clearTimeout(__pcpBackfillBannerHideTimer);
          __pcpBackfillBannerHideTimer = setTimeout(function(){
            __pcpBackfillBannerHideTimer = null;
            if (isBackfillUiActive()) {
              showBackfillBanner();
              return;
            }
            if (!window.__pcpBackfillBannerVisible) {
              showFinalToastAfterBackfill();
              return;
            }
            window.__pcpBackfillBannerVisible = false;
            window.__pcpBackfillBannerError = false;
            var el = document.getElementById('pcp-health-backfill-banner');
            if (el) el.style.display = 'none';
            log('[UI] Bandeau import historique masqué');
            showFinalToastAfterBackfill();
            if (window.__pcpDeferLogShareUntilBackfill) {
              window.__pcpDeferLogShareUntilBackfill = false;
              showLogSharePrompt();
            }
          }, wait);
        } catch(e) {}
      }
      function syncBackfillBanner(){
        if (shouldShowBackfillBanner()) showBackfillBanner();
        else if (window.__pcpBackfillBannerVisible || __pcpBackfillBannerHideTimer) hideBackfillBanner(false);
      }
      window.showBackfillBanner = showBackfillBanner;
      window.hideBackfillBanner = hideBackfillBanner;
      function installBackfillBannerUi(){
        if (window.__pcpBackfillBannerUi) return;
        window.__pcpBackfillBannerUi = true;
        window.addEventListener('pcp-health-backfill-started', function(){
          window.__pcpDeferLogShareUntilBackfill = true;
          showBackfillBanner();
        });
        window.addEventListener('pcp-health-backfill-finished', function(ev){
          var d = ev && ev.detail ? ev.detail : {};
          if (d.ok === false) {
            window.__pcpPendingFinalToast = null;
            window.__pcpDeferLogShareUntilBackfill = true;
            showBackfillBanner({ forceError: true });
            log('[UI] Bandeau import historique — échec, reprise au swipe');
            return;
          }
          if (!window.__pcpPendingManualSync && !window.__pcpHealthSyncRunning) {
            window.__pcpPendingFinalToast = 'success';
          } else {
            window.__pcpPendingFinalToast = null;
            window.__pcpDeferLogShareUntilBackfill = true;
          }
          hideBackfillBanner(false);
        });
        window.addEventListener('pcp-health-sync-finished', function(ev){
          var d = ev && ev.detail ? ev.detail : {};
          if (d.backfillPending) {
            window.__pcpDeferLogShareUntilBackfill = true;
            showBackfillBanner();
          }
        });
        document.addEventListener('visibilitychange', function(){
          if (document.visibilityState === 'visible') syncBackfillBanner();
        });
        setTimeout(syncBackfillBanner, 800);
      }
      function installSwipeSyncCoach(){
        if (window.__pcpHealthSwipeCoach) return;
        window.__pcpHealthSwipeCoach = true;
        var STORAGE_KEY = 'pcpHealthSwipeCoachSeen';
        var COACH_MSG = {
          fr: {
            title: 'Synchroniser vos données santé',
            body: 'Sur cet écran, glissez vers la gauche pour envoyer vos données Apple Santé à votre espace patient.',
            ok: 'Compris',
            hint: 'Glissez'
          },
          en: {
            title: 'Sync your health data',
            body: 'On this screen, swipe left to send your Apple Health data to your patient portal.',
            ok: 'Got it',
            hint: 'Swipe'
          }
        };
        function coachMsg(key){
          var loc = getAppLocale();
          var m = COACH_MSG[loc] || COACH_MSG.fr;
          return m[key] || COACH_MSG.fr[key];
        }
        function isPatientHome(){
          try { return /\\/patient\\/home/.test(window.location.pathname || ''); }
          catch(e) { return false; }
        }
        function coachSeen(){
          try { return localStorage.getItem(STORAGE_KEY) === '1'; }
          catch(e) { return true; }
        }
        function dismissCoach(markSeen){
          var el = document.getElementById('pcp-health-swipe-coach');
          if (el) {
            clearInterval(el.__pcpCoachAnim);
            el.remove();
          }
          if (markSeen) {
            try { localStorage.setItem(STORAGE_KEY, '1'); } catch(e) {}
          }
        }
        function ensureCoachStyles(){
          if (document.getElementById('pcp-health-coach-style')) return;
          var s = document.createElement('style');
          s.id = 'pcp-health-coach-style';
          s.textContent = [
            '#pcp-health-swipe-coach{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;',
            'padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom));box-sizing:border-box;',
            'background:rgba(2,6,23,0.14);animation:pcpCoachOverlayIn .45s ease}',
            '.pcp-coach-card{position:relative;margin:0;max-width:360px;width:calc(100% - 32px);padding:28px 22px 22px;border-radius:26px;pointer-events:auto;',
            'background:linear-gradient(165deg,rgba(15,23,42,0.62),rgba(2,6,23,0.52));',
            '-webkit-backdrop-filter:blur(26px) saturate(170%);backdrop-filter:blur(26px) saturate(170%);',
            'border:1px solid rgba(148,163,184,0.22);overflow:hidden;',
            'box-shadow:0 32px 80px rgba(2,6,23,0.5),0 0 0 1px rgba(255,255,255,0.06) inset,0 1px 0 rgba(255,255,255,0.12) inset;',
            'animation:pcpCoachCardIn .55s cubic-bezier(.22,1,.36,1)}',
            '.pcp-coach-card::after{content:"";position:absolute;top:-50%;left:50%;width:240px;height:240px;margin-left:-120px;border-radius:50%;pointer-events:none;',
            'background:radial-gradient(circle,rgba(56,189,248,0.28),rgba(56,189,248,0) 70%);filter:blur(6px);animation:pcpCoachAura 5s ease-in-out infinite}',
            '.pcp-coach-badge{position:relative;width:56px;height:56px;border-radius:17px;display:flex;align-items:center;justify-content:center;margin-bottom:18px;',
            'background:linear-gradient(145deg,rgba(56,189,248,0.22),rgba(168,85,247,0.22));border:1px solid rgba(148,163,184,0.22);',
            'box-shadow:0 0 22px rgba(56,189,248,0.28) inset,0 10px 26px rgba(2,6,23,0.5)}',
            '.pcp-coach-badge::before{content:"";position:absolute;inset:-6px;border-radius:22px;border:1px solid rgba(56,189,248,0.4);animation:pcpCoachRing 2.4s ease-out infinite}',
            '.pcp-coach-badge .material-symbols-outlined{font-size:28px;color:#e0f2fe;text-shadow:0 0 14px rgba(56,189,248,0.85)}',
            '.pcp-coach-gesture{position:relative;margin-bottom:22px;padding:18px 18px;border-radius:18px;overflow:hidden;',
            'background:linear-gradient(145deg,rgba(30,41,59,0.55),rgba(15,23,42,0.55));border:1px solid rgba(148,163,184,0.14)}',
            '.pcp-coach-hint-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
            '.pcp-coach-hint{font:600 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:#7dd3fc}',
            '.pcp-coach-chevrons{display:inline-flex;gap:1px}',
            '.pcp-coach-chevrons span{font-size:20px;line-height:1;color:#38bdf8;text-shadow:0 0 10px rgba(56,189,248,0.7);animation:pcpCoachChev 1.2s ease-in-out infinite}',
            '.pcp-coach-chevrons span:nth-child(2){animation-delay:.14s}',
            '.pcp-coach-chevrons span:nth-child(3){animation-delay:.28s}',
            '.pcp-coach-track{position:relative;height:6px;border-radius:999px;background:rgba(148,163,184,0.16);overflow:hidden;margin-top:14px}',
            '.pcp-coach-track::before{content:"";position:absolute;inset:0;border-radius:inherit;',
            'background:linear-gradient(90deg,rgba(56,189,248,0) 0%,rgba(56,189,248,0.45) 50%,rgba(56,189,248,0) 100%);',
            'transform:translateX(100%);animation:pcpCoachSweep 1.8s cubic-bezier(.65,0,.35,1) infinite}',
            '.pcp-coach-orb{position:absolute;top:50%;right:5px;width:14px;height:14px;margin-top:-7px;border-radius:50%;',
            'background:radial-gradient(circle at 32% 30%,#f0f9ff,#38bdf8);',
            'box-shadow:0 0 12px rgba(56,189,248,0.95),0 0 26px rgba(99,102,241,0.6);',
            'animation:pcpCoachSwipe 1.8s cubic-bezier(.65,0,.35,1) infinite}',
            '.pcp-coach-title{margin:0 0 10px;font:700 20px/1.25 system-ui,-apple-system,sans-serif;letter-spacing:-.02em;',
            'background:linear-gradient(90deg,#e0f2fe,#a5b4fc);-webkit-background-clip:text;background-clip:text;color:transparent}',
            '.pcp-coach-body{margin:0 0 22px;font:500 14px/1.55 system-ui,-apple-system,sans-serif;color:rgba(203,213,225,0.85)}',
            '.pcp-coach-btn{position:relative;width:100%;padding:15px 18px;border-radius:14px;cursor:pointer;',
            'font:600 15px/1 system-ui,-apple-system,sans-serif;letter-spacing:.01em;color:#e2e8f0;',
            'background:rgba(255,255,255,0.08);border:1px solid rgba(148,163,184,0.28);',
            '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);',
            'transition:transform .15s ease,background .2s ease,border-color .2s ease}',
            '.pcp-coach-btn:active{transform:scale(.97);background:rgba(255,255,255,0.14);border-color:rgba(148,163,184,0.4)}',
            '@keyframes pcpCoachOverlayIn{from{opacity:0}to{opacity:1}}',
            '@keyframes pcpCoachCardIn{from{opacity:0;transform:translateY(18px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
            '@keyframes pcpCoachAura{0%,100%{opacity:.5;transform:scale(1)}50%{opacity:.9;transform:scale(1.15)}}',
            '@keyframes pcpCoachRing{0%{transform:scale(.85);opacity:.8}100%{transform:scale(1.3);opacity:0}}',
            '@keyframes pcpCoachSwipe{0%{right:5px;opacity:0}14%{opacity:1}85%{opacity:1}100%{right:calc(100% - 19px);opacity:0}}',
            '@keyframes pcpCoachSweep{0%{transform:translateX(100%)}100%{transform:translateX(-100%)}}',
            '@keyframes pcpCoachChev{0%,100%{opacity:.25;transform:translateX(2px)}50%{opacity:1;transform:translateX(-2px)}}'
          ].join('');
          document.head.appendChild(s);
        }
        async function showCoachIfAuthorized(){
          if (!isIosApp() || !isPatientHome() || coachSeen()) return false;
          var Health = (window.Capacitor && window.Capacitor.Plugins)
            ? window.Capacitor.Plugins.Health : null;
          if (!Health) return false;
          try {
            var n = await countHealthReadGranted(Health);
            if (n === 0) return false;
          } catch(e) { return false; }
          showCoach();
          return true;
        }
        function showCoach(){
          if (!isIosApp() || !isPatientHome() || coachSeen()) return;
          if (document.getElementById('pcp-health-swipe-coach')) return;
          ensureCoachStyles();
          var overlay = document.createElement('div');
          overlay.id = 'pcp-health-swipe-coach';
          overlay.setAttribute('role', 'dialog');
          overlay.setAttribute('aria-modal', 'true');
          var card = document.createElement('div');
          card.className = 'pcp-coach-card';
          var badge = document.createElement('div');
          badge.className = 'pcp-coach-badge';
          var badgeIcon = document.createElement('span');
          badgeIcon.className = 'material-symbols-outlined';
          badgeIcon.textContent = 'swipe_left';
          badge.appendChild(badgeIcon);
          var gesture = document.createElement('div');
          gesture.className = 'pcp-coach-gesture';
          var hintRow = document.createElement('div');
          hintRow.className = 'pcp-coach-hint-row';
          var hintEl = document.createElement('span');
          hintEl.className = 'pcp-coach-hint';
          hintEl.textContent = coachMsg('hint');
          var arrowsEl = document.createElement('span');
          arrowsEl.className = 'pcp-coach-chevrons';
          arrowsEl.innerHTML = '<span>‹</span><span>‹</span><span>‹</span>';
          hintRow.appendChild(hintEl);
          hintRow.appendChild(arrowsEl);
          var track = document.createElement('div');
          track.className = 'pcp-coach-track';
          var orb = document.createElement('div');
          orb.className = 'pcp-coach-orb';
          track.appendChild(orb);
          gesture.appendChild(hintRow);
          gesture.appendChild(track);
          var title = document.createElement('h2');
          title.className = 'pcp-coach-title';
          title.textContent = coachMsg('title');
          var body = document.createElement('p');
          body.className = 'pcp-coach-body';
          body.textContent = coachMsg('body');
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pcp-coach-btn';
          btn.textContent = coachMsg('ok');
          btn.addEventListener('click', function(){ dismissCoach(true); });
          card.appendChild(badge);
          card.appendChild(gesture);
          card.appendChild(title);
          card.appendChild(body);
          card.appendChild(btn);
          overlay.appendChild(card);
          overlay.addEventListener('click', function(e){
            if (e.target === overlay) dismissCoach(true);
          });
          document.body.appendChild(overlay);
        }
        function tryShowSwipeCoachAfterAuth(){
          window.__pcpSwipeCoachPending = true;
          window.setTimeout(async function(){
            if (coachSeen()) {
              window.__pcpSwipeCoachPending = false;
              return;
            }
            var shown = await showCoachIfAuthorized();
            if (shown) window.__pcpSwipeCoachPending = false;
          }, 1200);
        }
        window.tryShowSwipeCoachAfterAuth = tryShowSwipeCoachAfterAuth;
        window.addEventListener('pcp-health-authorized', function(){
          tryShowSwipeCoachAfterAuth();
        });
        window.addEventListener('pcp-health-sync-finished', function(ev){
          var d = ev && ev.detail ? ev.detail : {};
          if (d.manual && d.ok !== false && !d.skipped && d.reason !== 'no_data') dismissCoach(true);
        });
      }
      function installSwipeLeftSync(){
        if (window.__pcpHealthSwipeLeft) return;
        window.__pcpHealthSwipeLeft = true;
        var SWIPE_THRESHOLD = 88;
        var SWIPE_MAX = 128;
        var VERTICAL_CANCEL = 36;
        var active = false;
        var startX = 0;
        var startY = 0;
        var swipe = 0;
        function isPatientHome(){
          try { return /\\/patient\\/home/.test(window.location.pathname || ''); }
          catch(e) { return false; }
        }
        function insideNestedScroller(el){
          while (el && el !== document.body) {
            if (el.dataset && el.dataset.noSwipeSync != null) return true;
            try {
              var style = window.getComputedStyle(el);
              var scrollableX = (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
                el.scrollWidth > el.clientWidth + 1;
              var scrollableY = (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                el.scrollHeight > el.clientHeight + 1;
              if (scrollableX || scrollableY) return true;
            } catch(e) {}
            el = el.parentElement;
          }
          return false;
        }
        function ensureSwipeIndicator(){
          var id = 'pcp-health-swipe-indicator';
          var el = document.getElementById(id);
          if (el) return el;
          el = document.createElement('div');
          el.id = id;
          el.style.cssText = 'position:fixed;top:calc(4.25rem + env(safe-area-inset-top));right:max(12px, env(safe-area-inset-right));z-index:99998;pointer-events:none;opacity:0;transition:opacity .15s ease, transform .12s ease;width:max-content;max-width:calc(100vw - 24px)';
          el.innerHTML = '<div id="pcp-health-swipe-pill" style="display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;border-radius:999px;font:600 12px/1.2 system-ui,-apple-system,sans-serif;background:#fff;color:#525252;border:1px solid #e5e5e5;box-shadow:0 4px 14px rgba(0,0,0,0.08);white-space:nowrap;width:max-content;max-width:100%;box-sizing:border-box"></div>';
          document.body.appendChild(el);
          return el;
        }
        function updateSwipeIndicator(distance){
          var wrap = ensureSwipeIndicator();
          var pill = document.getElementById('pcp-health-swipe-pill');
          if (!pill) return;
          if (distance <= 0) {
            wrap.style.opacity = '0';
            wrap.style.transform = 'translateX(0)';
            return;
          }
          var ready = distance >= SWIPE_THRESHOLD;
          pill.style.background = ready ? '#2563eb' : '#fff';
          pill.style.color = ready ? '#fff' : '#525252';
          pill.style.borderColor = ready ? '#2563eb' : '#e5e5e5';
          pill.textContent = ready ? syncMsg('release') : syncMsg('pull');
          wrap.style.opacity = '1';
          wrap.style.transform = 'translateX(-' + (Math.min(distance, SWIPE_THRESHOLD) * 0.22) + 'px)';
        }
        function resetSwipe(){
          active = false;
          swipe = 0;
          updateSwipeIndicator(0);
        }
        document.addEventListener('touchstart', function(e){
          if (document.body && document.body.dataset && document.body.dataset.pcpHealthSwipe === 'frontend') return;
          if (!isPatientHome()) return;
          if (e.touches.length !== 1) return;
          if (insideNestedScroller(e.target)) return;
          if (!window.__pcpManualSyncLock && !window.__pcpHealthSyncRunning) {
            window.__pcpSwipeAuthPrefetch = resolveSyncAuthToken();
          }
          active = true;
          startX = e.touches[0].clientX;
          startY = e.touches[0].clientY;
        }, { passive: true });
        document.addEventListener('touchmove', function(e){
          if (!active) return;
          if (document.body && document.body.dataset && document.body.dataset.pcpHealthSwipe === 'frontend') return;
          var dx = e.touches[0].clientX - startX;
          var dy = e.touches[0].clientY - startY;
          if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > VERTICAL_CANCEL) { resetSwipe(); return; }
          if (dx >= 0) { resetSwipe(); return; }
          swipe = Math.min(SWIPE_MAX, -dx * 0.55);
          updateSwipeIndicator(swipe);
        }, { passive: true });
        document.addEventListener('touchend', function(){
          if (!active) return;
          var swiped = swipe;
          resetSwipe();
          if (swiped < SWIPE_THRESHOLD) return;
          if (!window.PcpHealthBridge || !window.PcpHealthBridge.triggerSync) return;
          triggerSyncHaptic();
          window.PcpHealthBridge.triggerSync();
        }, { passive: true });
        document.addEventListener('touchcancel', resetSwipe, { passive: true });
        var __pcpSyncErrorToastTimer = null;
        window.addEventListener('pcp-health-sync-started', function(ev){
          var d = ev && ev.detail ? ev.detail : {};
          if (!d.manual) return;
          if (shouldShowBackfillBusyToast()) {
            showBackfillBusyToast();
            return;
          }
          if (__pcpSyncErrorToastTimer) {
            clearTimeout(__pcpSyncErrorToastTimer);
            __pcpSyncErrorToastTimer = null;
          }
          showSyncToast(syncMsg('syncing'), { persist: true });
          showLogSharePrompt();
        });
        window.addEventListener('pcp-health-sync-finished', function(ev){
          var d = ev && ev.detail ? ev.detail : {};
          if (!d.manual) return;
          if (d.skipped && d.reason === 'busy') {
            window.__pcpPendingManualSync = true;
            if (shouldShowBackfillBusyToast()) {
              showBackfillBusyToast();
              return;
            }
            showSyncToast(syncMsg('syncing'), { persist: true });
            showLogSharePrompt();
            return;
          }
          if (d.skipped && d.reason === 'interval') {
            showSyncToast(syncMsg('recent'), { error: false });
            return;
          }
          if (d.reason === 'no_data' || (d.empty && d.ok === false)) {
            if (__pcpSyncErrorToastTimer) clearTimeout(__pcpSyncErrorToastTimer);
            dismissSyncToast();
            showSyncToast(syncMsg('empty_no_data'), { warn: true });
            showLogSharePrompt();
            return;
          }
          if (d.ok === false) {
            if (__pcpSyncErrorToastTimer) clearTimeout(__pcpSyncErrorToastTimer);
            dismissSyncToast();
            showLogSharePrompt();
            if (d.reason === 'no_health_auth' || d.reason === 'health_auth_cancelled') {
              return;
            }
            if (d.reason === 'auth_expired') {
              showSyncToast(syncMsg('error_session'), { error: true });
              return;
            }
            var errDetail = d;
            showSyncToast(formatSyncError(errDetail), { error: true });
            return;
          }
          if (__pcpSyncErrorToastTimer) {
            clearTimeout(__pcpSyncErrorToastTimer);
            __pcpSyncErrorToastTimer = null;
          }
          if (d.ok !== false && !d.skipped) {
            var syncDone = !d.backfillPending || d.mode === 'incremental';
            if (syncDone) {
              dismissSyncToast();
              if (d.mode === 'incremental' && window.__pcpBackfillBannerVisible && window.hideBackfillBanner) {
                window.__pcpPendingFinalToast = 'success';
                window.hideBackfillBanner(true);
              } else {
                showSyncToast(syncMsg('success'));
              }
              if (window.PcpHealthDisplayRefresh && window.PcpHealthDisplayRefresh.pulse) {
                window.PcpHealthDisplayRefresh.pulse();
              }
            }
          }
          if (!d.backfillPending) showLogSharePrompt();
        });
      }
      installBackfillBannerUi();
      pollSession();
      setInterval(pollSession, 15000);
      setInterval(watchRouteForHealthPrompt, 800);
      document.addEventListener('visibilitychange', function(){
        if (document.visibilityState === 'visible') {
          pollSession();
        } else if (__pcpAutoSyncTimer) {
          clearTimeout(__pcpAutoSyncTimer);
          __pcpAutoSyncTimer = null;
        }
      });
      installSwipeLeftSync();
      installSwipeSyncCoach();
    })();
    """

    static func shouldInject(for url: URL?) -> Bool {
        guard let url else { return false }
        if PcpOfflinePage.isOfflinePage(url) { return false }
        guard let host = url.host?.lowercased() else { return false }
        return host.contains("pcpinnov.com") || host == "localhost"
    }

    private static func injectOsVersion(into webView: WKWebView) {
        let ver = UIDevice.current.systemVersion.replacingOccurrences(of: "'", with: "")
        webView.evaluateJavaScript("window.__pcpOsVersion='\(ver)';", completionHandler: nil)
    }

    static func inject(into webView: WKWebView) {
        injectOsVersion(into: webView)
        webView.evaluateJavaScript(script) { _, _ in
            injectSyncLibrary(into: webView)
        }
    }

    /// Charge health-log-export.js + health-daily-aggregates.js + health-display-refresh.js + health-server-backfill-probe.js + health-ios-sync.js + health-sync-indicator.js depuis le bundle (public/).
    private static func injectSyncLibrary(into webView: WKWebView) {
        guard let constantsJs = loadBundledScript(named: "health-sync-constants"),
              let logExportJs = loadBundledScript(named: "health-log-export"),
              let aggregatesJs = loadBundledScript(named: "health-daily-aggregates"),
              let syncJs = loadBundledScript(named: "health-ios-sync"),
              let displayJs = loadBundledScript(named: "health-display-refresh") else {
            NSLog("[PcpHealth] scripts santé absents du bundle — lance: npx cap copy ios")
            return
        }
        let probeJs = loadBundledScript(named: "health-server-backfill-probe")
            ?? "(function(){window.PcpHealthServerBackfillProbe=window.PcpHealthServerBackfillProbe||{maybeSkipBackfillFromServer:function(){return Promise.resolve({applied:false,reason:'probe_missing'})}};})();"
        let indicatorJs = loadBundledScript(named: "health-sync-indicator")
        webView.evaluateJavaScript(constantsJs) { _, constantsError in
            if let constantsError {
                NSLog("[PcpHealth] injection health-sync-constants.js: \(constantsError.localizedDescription)")
                return
            }
            webView.evaluateJavaScript(logExportJs) { _, logError in
            if let logError {
                NSLog("[PcpHealth] injection health-log-export.js: \(logError.localizedDescription)")
                return
            }
            webView.evaluateJavaScript(aggregatesJs) { _, aggError in
                if let aggError {
                    NSLog("[PcpHealth] injection health-daily-aggregates.js: \(aggError.localizedDescription)")
                    return
                }
                webView.evaluateJavaScript(displayJs) { _, displayError in
                    if let displayError {
                        NSLog("[PcpHealth] injection health-display-refresh.js: \(displayError.localizedDescription)")
                        return
                    }
                    webView.evaluateJavaScript(probeJs) { _, probeError in
                        if let probeError {
                            NSLog("[PcpHealth] injection health-server-backfill-probe.js: \(probeError.localizedDescription)")
                            return
                        }
                        webView.evaluateJavaScript(syncJs) { _, syncError in
                        if let syncError {
                            NSLog("[PcpHealth] injection health-ios-sync.js: \(syncError.localizedDescription)")
                            return
                        }
                        let finishInject = {
                            let ready = "try{window.__pcpHealthOnSyncLibReady&&window.__pcpHealthOnSyncLibReady();window.PcpHealthSyncIndicator&&window.PcpHealthSyncIndicator.sync&&window.PcpHealthSyncIndicator.sync();}catch(e){console.log('[PcpHealth]',e);}"
                            webView.evaluateJavaScript(ready, completionHandler: nil)
                        }
                        if let indicatorJs {
                            webView.evaluateJavaScript(indicatorJs) { _, indicatorError in
                                if let indicatorError {
                                    NSLog("[PcpHealth] injection health-sync-indicator.js: \(indicatorError.localizedDescription)")
                                }
                                finishInject()
                            }
                        } else {
                            finishInject()
                        }
                    }
                    }
                }
            }
            }
        }
    }

    private static func loadBundledScript(named name: String) -> String? {
        let bundle = Bundle.main
        if let url = bundle.url(forResource: name, withExtension: "js", subdirectory: "public") {
            return try? String(contentsOf: url, encoding: .utf8)
        }
        if let url = bundle.url(forResource: name, withExtension: "js") {
            return try? String(contentsOf: url, encoding: .utf8)
        }
        if let resourcePath = bundle.resourcePath {
            let path = (resourcePath as NSString).appendingPathComponent("public/\(name).js")
            if FileManager.default.fileExists(atPath: path) {
                return try? String(contentsOfFile: path, encoding: .utf8)
            }
        }
        return nil
    }
}

// MARK: - WebView file upload (<input type="file">)

/// WKWebView does not open the photo picker by itself — without this handler the app can crash
/// when the patient portal triggers a file input (avatar, documents).
private final class WebViewFilePickerCoordinator: NSObject {
    weak var presenter: UIViewController?
    private var completion: (([URL]?) -> Void)?

    func present(
        allowsMultiple: Bool,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let top = Self.topViewController(base: presenter) else {
            completionHandler(nil)
            return
        }
        cancelPending()
        completion = completionHandler

        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Bibliothèque photos", style: .default) { [weak self] _ in
            self?.presentPhotoLibrary(from: top, allowsMultiple: allowsMultiple)
        })
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            sheet.addAction(UIAlertAction(title: "Appareil photo", style: .default) { [weak self] _ in
                self?.presentCamera(from: top)
            })
        }
        sheet.addAction(UIAlertAction(title: "Annuler", style: .cancel) { [weak self] _ in
            self?.finish(with: nil)
        })
        Self.configurePopover(sheet, on: top)
        top.present(sheet, animated: true)
    }

    private func presentPhotoLibrary(from presenter: UIViewController, allowsMultiple: Bool) {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = allowsMultiple ? 0 : 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        Self.configurePopover(picker, on: presenter)
        presenter.present(picker, animated: true)
    }

    private func presentCamera(from presenter: UIViewController) {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = ["public.image"]
        picker.delegate = self
        Self.configurePopover(picker, on: presenter)
        presenter.present(picker, animated: true)
    }

    private func finish(with urls: [URL]?) {
        let handler = completion
        completion = nil
        handler?(urls)
    }

    private func cancelPending() {
        completion?(nil)
        completion = nil
    }

    /// Routes a picked image back into the page (`__pcpApplyPickedFile` injected script).
    func presentForWebInput(webView: WKWebView, allowsMultiple: Bool) {
        present(allowsMultiple: allowsMultiple) { urls in
            DispatchQueue.main.async {
                guard let url = urls?.first,
                      let data = Self.jpegDataForWebUpload(from: url) else { return }
                let b64 = data.base64EncodedString()
                let js = "window.__pcpApplyPickedFile&&window.__pcpApplyPickedFile('\(b64)','image/jpeg','photo.jpg');"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    private static func jpegDataForWebUpload(from url: URL, maxDimension: CGFloat = 2048) -> Data? {
        guard let image = UIImage(contentsOfFile: url.path) else {
            return try? Data(contentsOf: url)
        }
        let size = image.size
        let longest = max(size.width, size.height)
        let scaled: UIImage
        if longest > maxDimension {
            let scale = maxDimension / longest
            let newSize = CGSize(width: size.width * scale, height: size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            scaled = renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        } else {
            scaled = image
        }
        return scaled.jpegData(compressionQuality: 0.88)
    }

    private static func configurePopover(_ controller: UIViewController, on presenter: UIViewController) {
        guard let popover = controller.popoverPresentationController else { return }
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.midY,
            width: 1,
            height: 1
        )
        popover.permittedArrowDirections = []
    }

    private static func topViewController(base: UIViewController?) -> UIViewController? {
        if let nav = base as? UINavigationController {
            return topViewController(base: nav.visibleViewController)
        }
        if let tab = base as? UITabBarController {
            return topViewController(base: tab.selectedViewController)
        }
        if let presented = base?.presentedViewController {
            return topViewController(base: presented)
        }
        return base
    }

    private static func persistImageData(_ data: Data, ext: String = "jpg") -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("pcp-upload-\(UUID().uuidString).\(ext)")
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }

    private static func copyToUploadTemp(_ source: URL) -> URL? {
        let ext = source.pathExtension.isEmpty ? "jpg" : source.pathExtension
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("pcp-upload-\(UUID().uuidString).\(ext)")
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.copyItem(at: source, to: dest)
            return dest
        } catch {
            return nil
        }
    }
}

extension WebViewFilePickerCoordinator: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self else { return }
            guard !results.isEmpty else {
                self.finish(with: nil)
                return
            }

            let group = DispatchGroup()
            var urls: [URL] = []
            let lock = NSLock()

            for result in results {
                group.enter()
                let provider = result.itemProvider
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { fileURL, _ in
                        defer { group.leave() }
                        guard let fileURL, let copied = Self.copyToUploadTemp(fileURL) else { return }
                        lock.lock()
                        urls.append(copied)
                        lock.unlock()
                    }
                } else {
                    provider.loadObject(ofClass: UIImage.self) { object, _ in
                        defer { group.leave() }
                        guard let image = object as? UIImage,
                              let data = image.jpegData(compressionQuality: 0.92),
                              let url = Self.persistImageData(data) else { return }
                        lock.lock()
                        urls.append(url)
                        lock.unlock()
                    }
                }
            }

            group.notify(queue: .main) {
                self.finish(with: urls.isEmpty ? nil : urls)
            }
        }
    }
}

extension WebViewFilePickerCoordinator: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true) { [weak self] in
            self?.finish(with: nil)
        }
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true) { [weak self] in
            guard let self else { return }
            guard let image = info[.originalImage] as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.92),
                  let url = Self.persistImageData(data) else {
                self.finish(with: nil)
                return
            }
            self.finish(with: [url])
        }
    }
}

// MARK: - Navigation proxy

/// Intercepts blob navigations before Capacitor calls UIApplication.open (unsupported for blob: URLs).
private final class BlobNavigationProxy: NSObject, WKNavigationDelegate, WKUIDelegate {
    weak var inner: WebViewDelegationHandler?
    weak var hostViewController: BridgeViewController?
    var blobCoordinator = BlobFileCoordinator()

    private func handleBlobNavigation(_ blobURL: URL, in webView: WKWebView) {
        blobCoordinator.presenter = hostViewController
        blobCoordinator.presentChoice(for: blobURL, from: webView)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else {
            return inner?.webView(
                webView,
                createWebViewWith: configuration,
                for: navigationAction,
                windowFeatures: windowFeatures
            )
        }

        if url.scheme?.lowercased() == "blob" {
            handleBlobNavigation(url, in: webView)
            return nil
        }

        if navigationAction.targetFrame == nil {
            webView.load(URLRequest(url: url))
            return nil
        }

        return inner?.webView(
            webView,
            createWebViewWith: configuration,
            for: navigationAction,
            windowFeatures: windowFeatures
        )
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, url.scheme?.lowercased() == "blob" {
            handleBlobNavigation(url, in: webView)
            decisionHandler(.cancel)
            return
        }

        inner?.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if PcpOfflinePage.isOfflinePage(webView.url) {
            hostViewController?.configureOfflinePullToRefresh(for: webView)
        } else {
            hostViewController?.clearOfflinePullToRefresh(from: webView)
        }
        if HealthSessionHook.shouldInject(for: webView.url) {
            HealthSessionHook.inject(into: webView)
        }
        hostViewController?.applySafeAreaToWeb(in: webView)
        inner?.webView(webView, didFinish: navigation)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            inner?.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
            return
        }
        NSLog(
            "[PcpOffline] provisional navigation failed: %@ → Capacitor errorPath",
            error.localizedDescription
        )
        // Capacitor WebViewDelegationHandler charge server.errorPath (offline.html).
        inner?.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            inner?.webView(webView, didFail: navigation, withError: error)
            return
        }
        NSLog(
            "[PcpOffline] navigation failed: %@ → Capacitor errorPath",
            error.localizedDescription
        )
        inner?.webView(webView, didFail: navigation, withError: error)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) {
            return true
        }
        return inner?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner
    }
}

// MARK: - Bridge view controller

final class BridgeViewController: CAPBridgeViewController {
    private static let healthLogHandlerName = "pcpHealthLog"
    private static let healthShareLogsHandlerName = "pcpHealthShareLogs"
    private static let healthHapticHandlerName = "pcpHealthHaptic"
    private static let healthReadWristTempHandlerName = "pcpHealthReadWristTemperature"
    private static let healthReadVo2MaxHandlerName = "pcpHealthReadVo2Max"
    private static let healthReadWorkoutsHandlerName = "pcpHealthReadWorkouts"
    private static let healthRequestAllReadHandlerName = "pcpHealthRequestAllReadAuthorization"
    private static let healthCheckNativeOnlyAuthHandlerName = "pcpHealthCheckNativeOnlyAuth"
    private static let healthSyncStateHandlerName = "pcpHealthSyncState"
    private static let offlineReloadHandlerName = "pcpOfflineReload"
    private static let pickImageHandlerName = WebFileUploadInjection.handlerName
    private static let downloadBlobHandlerName = WebFileDownloadInjection.handlerName
    private var blobNavigationProxy: BlobNavigationProxy?
    private let filePickerCoordinator = WebViewFilePickerCoordinator()
    private let blobFileCoordinator = BlobFileCoordinator()

    override var preferredStatusBarStyle: UIStatusBarStyle {
        traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = PcpAppColors.canvasBackground
        configureEdgeToEdgeWebView()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncSafeAreaInsetsToWeb()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) {
            view.backgroundColor = PcpAppColors.canvasBackground
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        installHealthLogBridge()
        installHealthShareLogsBridge()
        installHealthHapticBridge()
        installHealthWristTemperatureBridge()
        installHealthVo2MaxBridge()
        installHealthWorkoutsBridge()
        installHealthRequestAllReadBridge()
        installHealthCheckNativeOnlyAuthBridge()
        installHealthSyncStateBridge()
        installFileUploadBridge()
        installFileDownloadBridge()
        installOfflineReloadBridge()
        installBlobNavigationProxy()
        installSafeAreaInjection()
        configureEdgeToEdgeWebView()
        DispatchQueue.main.async { [weak self] in
            guard let self, let webView = self.webView else { return }
            self.applySafeAreaToWeb(in: webView)
        }
    }

    /// WKWebView file/camera sheets need a popover anchor on iPad — otherwise UIKit can crash.
    override func present(
        _ viewControllerToPresent: UIViewController,
        animated flag: Bool,
        completion: (() -> Void)? = nil
    ) {
        if viewControllerToPresent.popoverPresentationController?.sourceView == nil,
           let popover = viewControllerToPresent.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        super.present(viewControllerToPresent, animated: flag, completion: completion)
    }

    private func configureEdgeToEdgeWebView() {
        edgesForExtendedLayout = .all
        extendedLayoutIncludesOpaqueBars = true

        guard let webView else { return }
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.contentInset = .zero
        webView.scrollView.scrollIndicatorInsets = .zero
        // Prevent pinch / focus zoom from sticking in WKWebView (common with fast form filling).
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.bouncesZoom = false
    }

    /// Re-apply safe-area CSS + native inset fallback (`env()` is often 0 on first paint).
    func applySafeAreaToWeb(in webView: WKWebView) {
        let top = view.safeAreaInsets.top
        let bottom = view.safeAreaInsets.bottom
        let js = """
        (function(){
          if (window.__pcpEnsureSafeArea) window.__pcpEnsureSafeArea();
          if (window.__pcpSetSafeAreaInsets) window.__pcpSetSafeAreaInsets(\(top), \(bottom));
        })();
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
        webView.scrollView.setZoomScale(1, animated: false)
    }

    private func syncSafeAreaInsetsToWeb() {
        guard let webView else { return }
        applySafeAreaToWeb(in: webView)
    }

    private func installSafeAreaInjection() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.addUserScript(SafeAreaWebInjection.userScript)
    }

    private func installHealthLogBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthLogHandlerName)
        controller.add(self, name: Self.healthLogHandlerName)
    }

    private func installHealthShareLogsBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthShareLogsHandlerName)
        controller.add(self, name: Self.healthShareLogsHandlerName)
    }

    private func installHealthHapticBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthHapticHandlerName)
        controller.add(self, name: Self.healthHapticHandlerName)
    }

    private func installHealthWristTemperatureBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthReadWristTempHandlerName)
        controller.add(self, name: Self.healthReadWristTempHandlerName)
    }

    private func installHealthVo2MaxBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthReadVo2MaxHandlerName)
        controller.add(self, name: Self.healthReadVo2MaxHandlerName)
    }

    private func installHealthWorkoutsBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthReadWorkoutsHandlerName)
        controller.add(self, name: Self.healthReadWorkoutsHandlerName)
    }

    private func installHealthRequestAllReadBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthRequestAllReadHandlerName)
        controller.add(self, name: Self.healthRequestAllReadHandlerName)
    }

    private func installHealthCheckNativeOnlyAuthBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthCheckNativeOnlyAuthHandlerName)
        controller.add(self, name: Self.healthCheckNativeOnlyAuthHandlerName)
    }

    private func installHealthSyncStateBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.healthSyncStateHandlerName)
        controller.add(self, name: Self.healthSyncStateHandlerName)
    }

    private func installFileUploadBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.pickImageHandlerName)
        controller.add(self, name: Self.pickImageHandlerName)
        controller.addUserScript(WebFileUploadInjection.userScript)
    }

    private func installFileDownloadBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.downloadBlobHandlerName)
        controller.add(self, name: Self.downloadBlobHandlerName)
        controller.addUserScript(WebFileDownloadInjection.userScript)
    }

    private func playSyncHaptic(style: String) {
        let feedbackStyle: UIImpactFeedbackGenerator.FeedbackStyle
        switch style {
        case "light": feedbackStyle = .light
        case "heavy": feedbackStyle = .heavy
        default: feedbackStyle = .medium
        }
        let generator = UIImpactFeedbackGenerator(style: feedbackStyle)
        generator.prepare()
        generator.impactOccurred()
    }

    private func installOfflineReloadBridge() {
        guard let webView else { return }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: Self.offlineReloadHandlerName)
        controller.add(self, name: Self.offlineReloadHandlerName)
    }

    private static let offlinePageBackground = UIColor(
        red: 245 / 255,
        green: 246 / 255,
        blue: 248 / 255,
        alpha: 1
    )

    func configureOfflinePullToRefresh(for webView: WKWebView) {
        // Pull géré côté offline.html — pas de rubber-band natif (sinon bande noire en overscroll).
        webView.scrollView.refreshControl = nil
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.backgroundColor = Self.offlinePageBackground
        webView.scrollView.backgroundColor = Self.offlinePageBackground
        webView.isOpaque = true
    }

    func clearOfflinePullToRefresh(from webView: WKWebView) {
        webView.scrollView.refreshControl = nil
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
    }

    private func installBlobNavigationProxy() {
        guard let webView else {
            NSLog("[PcpOffline] BlobNavigationProxy: webView unavailable")
            return
        }
        guard let capBridge = bridge as? CapacitorBridge else {
            NSLog("[PcpOffline] BlobNavigationProxy: CapacitorBridge cast failed — errorPath still handled by default delegate")
            return
        }

        let proxy = BlobNavigationProxy()
        proxy.inner = capBridge.webViewDelegationHandler
        proxy.hostViewController = self
        blobNavigationProxy = proxy

        webView.uiDelegate = proxy
        webView.navigationDelegate = proxy
    }
}

extension BridgeViewController {
    fileprivate func handleDownloadBlobMessage(_ body: Any) {
        let dict: [String: Any]?
        if let map = body as? [String: Any] {
            dict = map
        } else if let json = body as? String,
                  let data = json.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            dict = parsed
        } else {
            dict = nil
        }

        guard let dict else {
            blobFileCoordinator.presenter = self
            presentDownloadErrorAlert()
            return
        }

        if let jsError = dict["error"] as? String, !jsError.isEmpty {
            NSLog("[PcpDownload] JS error: %@", jsError)
            presentDownloadErrorAlert()
            return
        }

        guard let base64 = dict["base64"] as? String, !base64.isEmpty else {
            presentDownloadErrorAlert()
            return
        }

        let mimeType = (dict["mimeType"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "application/octet-stream"
        let filename = (dict["filename"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "document"
        blobFileCoordinator.savePayload(
            base64: base64,
            mimeType: mimeType,
            filename: filename,
            from: self
        )
    }

    fileprivate func presentDownloadErrorAlert() {
        let alert = UIAlertController(
            title: "Téléchargement impossible",
            message: "Réessayez dans quelques instants.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

extension BridgeViewController: WKScriptMessageHandler {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == Self.healthHapticHandlerName {
            let style = message.body as? String ?? "medium"
            DispatchQueue.main.async { [weak self] in
                self?.playSyncHaptic(style: style)
            }
            return
        }
        if message.name == Self.pickImageHandlerName {
            let body = message.body as? [String: Any]
            let multiple = (body?["multiple"] as? Bool) ?? false
            DispatchQueue.main.async { [weak self] in
                guard let self, let webView = self.webView else { return }
                self.filePickerCoordinator.presenter = self
                self.filePickerCoordinator.presentForWebInput(
                    webView: webView,
                    allowsMultiple: multiple
                )
            }
            return
        }
        if message.name == Self.downloadBlobHandlerName {
            DispatchQueue.main.async { [weak self] in
                self?.handleDownloadBlobMessage(message.body)
            }
            return
        }
        if message.name == Self.healthShareLogsHandlerName {
            let text = message.body as? String ?? String(describing: message.body)
            DispatchQueue.main.async { [weak self] in
                self?.presentShareHealthLogs(text: text)
            }
            return
        }
        if message.name == Self.healthReadWristTempHandlerName {
            DispatchQueue.main.async { [weak self] in
                self?.handleReadWristTemperatureMessage(message)
            }
            return
        }
        if message.name == Self.healthReadVo2MaxHandlerName {
            DispatchQueue.main.async { [weak self] in
                self?.handleReadVo2MaxMessage(message)
            }
            return
        }
        if message.name == Self.healthReadWorkoutsHandlerName {
            DispatchQueue.main.async { [weak self] in
                self?.handleReadWorkoutsMessage(message)
            }
            return
        }
        if message.name == Self.healthRequestAllReadHandlerName {
            handleRequestAllHealthReadAuthorization(message)
            return
        }
        if message.name == Self.healthCheckNativeOnlyAuthHandlerName {
            handleCheckNativeOnlyAuthMessage(message)
            return
        }
        if message.name == Self.healthSyncStateHandlerName {
            handleHealthSyncStateMessage(message)
            return
        }
        if message.name == Self.offlineReloadHandlerName {
            DispatchQueue.main.async { [weak self] in
                guard let self, let webView = self.webView else { return }
                PcpOfflinePage.reloadApp(in: webView)
            }
            return
        }
        guard message.name == Self.healthLogHandlerName else { return }
        if let text = message.body as? String {
            NSLog("[PcpHealth] %@", text)
        } else {
            NSLog("[PcpHealth] %@", String(describing: message.body))
        }
    }

    fileprivate func handleCheckNativeOnlyAuthMessage(_ message: WKScriptMessage) {
        let requestId: String
        if let map = message.body as? [String: Any], let id = map["requestId"] as? String {
            requestId = id
        } else {
            requestId = "nativeAuthCheck"
        }
        let pending = PcpHealthKitAuthorization.nativeOnlyTypesPending()
        let payload: [String: Any] = [
            "needsAuth": !pending.isEmpty,
            "pending": pending,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let escapedId = requestId
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        guard let webView else { return }
        let js = "window.__pcpNativeAuthCheckResolve&&window.__pcpNativeAuthCheckResolve('\(escapedId)', \(json));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    fileprivate func handleHealthSyncStateMessage(_ message: WKScriptMessage) {
        guard let map = message.body as? [String: Any],
              let action = map["action"] as? String,
              let patientId = map["patientId"] as? String,
              !patientId.isEmpty else {
            return
        }

        if action == "set" {
            let key = map["key"] as? String ?? ""
            let value = map["value"] as? String
            HealthSyncStateStore.setField(patientId: patientId, key: key, value: value)
            return
        }

        guard action == "get" else { return }
        let requestId = map["requestId"] as? String ?? "syncState"
        let state = HealthSyncStateStore.getState(patientId: patientId)
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        let escapedId = requestId
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        guard let webView else { return }
        let js = "window.__pcpHealthSyncStateResolve&&window.__pcpHealthSyncStateResolve('\(escapedId)', \(json));"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    fileprivate func handleRequestAllHealthReadAuthorization(_ message: WKScriptMessage) {
        let requestId: String
        if let map = message.body as? [String: Any], let id = map["requestId"] as? String {
            requestId = id
        } else {
            requestId = "auth"
        }
        let escaped = requestId
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")

        PcpHealthKitAuthorization.requestAllReadTypes { ok in
            guard let webView = self.webView else { return }
            let js = "window.__pcpHealthAuthResolve&&window.__pcpHealthAuthResolve('\(escaped)', \(ok ? "true" : "false"));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    fileprivate func handleReadWristTemperatureMessage(_ message: WKScriptMessage) {
        let dict: [String: Any]?
        if let map = message.body as? [String: Any] {
            dict = map
        } else if let json = message.body as? String,
                  let data = json.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            dict = parsed
        } else {
            dict = nil
        }

        guard let dict,
              let requestId = dict["requestId"] as? String,
              let startRaw = dict["startDate"] as? String,
              let endRaw = dict["endDate"] as? String else {
            return
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var start = formatter.date(from: startRaw)
        var end = formatter.date(from: endRaw)
        if start == nil {
            formatter.formatOptions = [.withInternetDateTime]
            start = formatter.date(from: startRaw)
            end = formatter.date(from: endRaw)
        }
        guard let start, let end else { return }

        PcpHealthKitWristTemperature.readSamplesWithDiagnostics(start: start, end: end) { [weak self] payload in
            guard let self, let webView = self.webView else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else {
                return
            }
            let escapedId = requestId
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = "window.__pcpWristTempResolve&&window.__pcpWristTempResolve('\(escapedId)', \(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    fileprivate func handleReadVo2MaxMessage(_ message: WKScriptMessage) {
        let dict: [String: Any]?
        if let map = message.body as? [String: Any] {
            dict = map
        } else if let json = message.body as? String,
                  let data = json.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            dict = parsed
        } else {
            dict = nil
        }

        guard let dict,
              let requestId = dict["requestId"] as? String,
              let startRaw = dict["startDate"] as? String,
              let endRaw = dict["endDate"] as? String else {
            return
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var start = formatter.date(from: startRaw)
        var end = formatter.date(from: endRaw)
        if start == nil {
            formatter.formatOptions = [.withInternetDateTime]
            start = formatter.date(from: startRaw)
            end = formatter.date(from: endRaw)
        }
        guard let start, let end else { return }

        PcpHealthKitVo2Max.readSamplesWithDiagnostics(start: start, end: end) { [weak self] payload in
            guard let self, let webView = self.webView else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else {
                return
            }
            let escapedId = requestId
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = "window.__pcpVo2MaxResolve&&window.__pcpVo2MaxResolve('\(escapedId)', \(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    fileprivate func handleReadWorkoutsMessage(_ message: WKScriptMessage) {
        let dict: [String: Any]?
        if let map = message.body as? [String: Any] {
            dict = map
        } else if let json = message.body as? String,
                  let data = json.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            dict = parsed
        } else {
            dict = nil
        }

        guard let dict,
              let requestId = dict["requestId"] as? String,
              let startRaw = dict["startDate"] as? String,
              let endRaw = dict["endDate"] as? String else {
            return
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var start = formatter.date(from: startRaw)
        var end = formatter.date(from: endRaw)
        if start == nil {
            formatter.formatOptions = [.withInternetDateTime]
            start = formatter.date(from: startRaw)
            end = formatter.date(from: endRaw)
        }
        guard let start, let end else { return }

        PcpHealthKitWorkouts.readWorkoutsWithDiagnostics(start: start, end: end) { [weak self] payload in
            guard let self, let webView = self.webView else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else {
                return
            }
            let escapedId = requestId
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = "window.__pcpWorkoutsResolve&&window.__pcpWorkoutsResolve('\(escapedId)', \(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    fileprivate func presentShareHealthLogs(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let stamp = formatter.string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("pcp-health-sync-\(stamp).txt")

        do {
            try trimmed.write(to: fileURL, atomically: true, encoding: .utf8)
        } catch {
            NSLog("[PcpHealth] export logs write error: \(error.localizedDescription)")
            return
        }

        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }

        let activity = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            popover.permittedArrowDirections = [.down, .up]
        }
        present(activity, animated: true)
    }
}
