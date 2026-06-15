import UIKit
import WebKit

// MARK: - App colors (match patient layout `bg-neutral-50`)

enum PcpAppColors {
    /// frontend `--color-neutral-50` (#F8F9FA) — patient portal canvas
    static let neutral50 = UIColor(red: 248 / 255, green: 249 / 255, blue: 250 / 255, alpha: 1)

    /// Background painted behind the WebView (overscroll / rubber-band zone).
    static let canvasBackground = UIColor { traitCollection in
        traitCollection.userInterfaceStyle == .dark ? .black : neutral50
    }
}

// MARK: - Web safe-area injection (remote patient portal, iOS app only)
//
// No native blur overlay on top of the WebView. Sticky headers already use
// `bg-neutral-50/80 backdrop-blur`. A ::before band fills the status-bar zone
// with the same frosted tint; padding-top keeps title/actions below the notch.

enum SafeAreaWebInjection {
    /// JS snippet run after each navigation + from document start.
    static let ensureScript = """
    (function(){
      if (!window.__pcpEnsureSafeArea) {
        window.__pcpSetSafeAreaInsets = function(topPx, bottomPx){
          var top = Math.max(0, Number(topPx) || 0);
          var bottom = Math.max(0, Number(bottomPx) || 0);
          document.documentElement.style.setProperty('--pcp-safe-top', top + 'px');
          document.documentElement.style.setProperty('--pcp-safe-bottom', bottom + 'px');
        };
        window.__pcpEnsureSafeArea = function(){
          document.documentElement.classList.add('pcp-ios');
          var meta = document.querySelector('meta[name="viewport"]');
          if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'viewport';
            (document.head || document.documentElement).appendChild(meta);
          }
          var c = meta.getAttribute('content') || 'width=device-width, initial-scale=1';
          if (!/viewport-fit=cover/.test(c)) {
            c += ', viewport-fit=cover';
          }
          if (!/maximum-scale\\s*=/.test(c)) { c += ', maximum-scale=1'; }
          if (!/user-scalable\\s*=/.test(c)) { c += ', user-scalable=no'; }
          meta.setAttribute('content', c);
          if (!document.getElementById('pcp-ios-safe-area')) {
            var style = document.createElement('style');
            style.id = 'pcp-ios-safe-area';
            style.textContent = [
              ':root {',
              '  --pcp-safe-top: env(safe-area-inset-top, 0px);',
              '  --pcp-safe-bottom: env(safe-area-inset-bottom, 0px);',
              '}',
              'html, body { background-color: #F8F9FA; }',
              '@media (prefers-color-scheme: dark) { html, body { background-color: #000; } }',
              'html.pcp-ios header[class*="sticky"],',
              'html.pcp-ios nav[class*="sticky"][class*="top-0"] {',
              '  padding-top: calc(var(--pcp-safe-top) + 1.5rem) !important;',
              '  box-sizing: border-box !important;',
              '}',
              'html.pcp-ios header[class*="sticky"]::before,',
              'html.pcp-ios nav[class*="sticky"][class*="top-0"]::before {',
              '  content: "";',
              '  position: absolute;',
              '  left: 0;',
              '  right: 0;',
              '  top: calc(-1 * var(--pcp-safe-top));',
              '  height: var(--pcp-safe-top);',
              '  background: rgba(248, 249, 250, 0.8);',
              '  -webkit-backdrop-filter: blur(12px);',
              '  backdrop-filter: blur(12px);',
              '  pointer-events: none;',
              '  z-index: -1;',
              '}',
              'html.pcp-ios nav[class*="fixed"][class*="bottom-0"] {',
              '  padding-bottom: calc(var(--pcp-safe-bottom) + 0.5rem) !important;',
              '}',
              'html.pcp-ios, html.pcp-ios body {',
              '  -webkit-text-size-adjust: 100%;',
              '  text-size-adjust: 100%;',
              '  touch-action: manipulation;',
              '}',
              'html.pcp-ios { font-size: 16px; }',
              'html.pcp-ios input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]):not([type=hidden]):not([type=image]),',
              'html.pcp-ios textarea,',
              'html.pcp-ios select { font-size: 16px !important; }',
              'html.pcp-ios [contenteditable="true"],',
              'html.pcp-ios .ProseMirror { font-size: 16px !important; }',
              '/* Wellness fullscreen — respiration / méditation (header sous la notch) */',
              'html.pcp-ios div.fixed.inset-0.z-50.bg-white {',
              '  box-sizing: border-box !important;',
              '}',
              'html.pcp-ios div.fixed.inset-0.z-50.bg-white > div.min-h-full.p-5,',
              'html.pcp-ios div.fixed.inset-0.z-50.bg-white > div.min-h-full.flex.flex-col.p-5 {',
              '  padding-top: calc(1.25rem + var(--pcp-safe-top)) !important;',
              '  padding-bottom: calc(1.25rem + var(--pcp-safe-bottom)) !important;',
              '  box-sizing: border-box !important;',
              '  min-height: 100% !important;',
              '}',
              'html.pcp-ios div.fixed.inset-0.z-50.bg-white div.min-h-full.relative > .top-5.left-5 {',
              '  top: calc(1.25rem + var(--pcp-safe-top)) !important;',
              '}',
              'html.pcp-ios div.fixed.inset-0.z-50.bg-white div.min-h-full.relative > .top-6.right-5 {',
              '  top: calc(1.5rem + var(--pcp-safe-top)) !important;',
              '}',
              'html.pcp-ios div.fixed.inset-0.z-50.bg-white div.min-h-full.relative .pb-12 {',
              '  padding-bottom: calc(3rem + var(--pcp-safe-bottom)) !important;',
              '}',
            ].join('\\n');
            (document.head || document.documentElement).appendChild(style);
          }
        };
      }
      window.__pcpEnsureSafeArea();
      if (!window.__pcpFocusZoomHook) {
        window.__pcpFocusZoomHook = true;
        document.addEventListener('focusout', function(ev){
          var t = ev.target;
          if (!t || !t.matches) return;
          if (!t.matches('input,textarea,select,[contenteditable="true"],.ProseMirror')) return;
          setTimeout(function(){
            window.__pcpEnsureSafeArea();
            try { window.scrollTo(0, window.scrollY || 0); } catch (_) {}
          }, 0);
        }, true);
      }
    })();
    """

    static let userScript = WKUserScript(
        source: ensureScript,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
}

// MARK: - File upload bridge (iOS 15–18.3 — WKOpenPanelParameters requires iOS 18.4+)

enum WebFileUploadInjection {
    static let handlerName = "pcpPickImage"

    static let userScript = WKUserScript(
        source: """
        (function(){
          if (window.__pcpFileUploadHook) return;
          window.__pcpFileUploadHook = true;
          if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.\(handlerName)) return;

          window.__pcpApplyPickedFile = function(b64, mime, name){
            var input = window.__pcpPendingFileInput;
            window.__pcpPendingFileInput = null;
            if (!input || !b64) return;
            try {
              var bin = atob(b64);
              var len = bin.length;
              var bytes = new Uint8Array(len);
              for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
              var file = new File([bytes], name || 'photo.jpg', { type: mime || 'image/jpeg' });
              var dt = new DataTransfer();
              dt.items.add(file);
              input.files = dt.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) {
              try { console.error('[PcpUpload]', e); } catch (_) {}
            }
          };

          var origClick = HTMLInputElement.prototype.click;
          HTMLInputElement.prototype.click = function() {
            if (this && this.type === 'file') {
              var accept = (this.accept || '').toLowerCase();
              var imageOnly = !accept || accept.indexOf('image') >= 0;
              if (imageOnly) {
                window.__pcpPendingFileInput = this;
                window.webkit.messageHandlers.\(handlerName).postMessage({
                  multiple: !!this.multiple
                });
                return;
              }
            }
            return origClick.call(this);
          };
        })();
        """,
        injectionTime: .atDocumentEnd,
        forMainFrameOnly: true
    )
}

// MARK: - File download bridge (blob: + <a download> in WKWebView)

enum WebFileDownloadInjection {
    static let handlerName = "pcpDownloadBlob"

    static let userScript = WKUserScript(
        source: """
        (function(){
          if (window.__pcpDownloadHook) return;
          window.__pcpDownloadHook = true;

          function hasNativeDownload(){
            return (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName))
              || (window.PcpHealthBridge && window.PcpHealthBridge.saveBlobDownload);
          }

          function postBlobDownload(payload){
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(handlerName)) {
              window.webkit.messageHandlers.\(handlerName).postMessage(payload);
              return true;
            }
            if (window.PcpHealthBridge && window.PcpHealthBridge.saveBlobDownload) {
              window.PcpHealthBridge.saveBlobDownload(JSON.stringify(payload));
              return true;
            }
            return false;
          }

          window.__pcpDeliverBlobDownload = async function(href, filename){
            if (!hasNativeDownload()) return false;
            try {
              var response = await fetch(href);
              var blob = await response.blob();
              var dataUrl = await new Promise(function(resolve, reject){
                var reader = new FileReader();
                reader.onloadend = function(){ resolve(reader.result); };
                reader.onerror = function(){ reject(reader.error); };
                reader.readAsDataURL(blob);
              });
              var parts = String(dataUrl).split(',');
              postBlobDownload({
                base64: parts.length > 1 ? parts[1] : '',
                mimeType: blob.type || 'application/octet-stream',
                filename: filename || 'document'
              });
              return true;
            } catch (e) {
              postBlobDownload({ error: String(e) });
              return false;
            }
          };

          var origRevoke = URL.revokeObjectURL.bind(URL);
          URL.revokeObjectURL = function(url){
            var href = (typeof url === 'string') ? url : (url && url.href ? url.href : '');
            if (href && href.indexOf('blob:') === 0 && hasNativeDownload()) {
              setTimeout(function(){ origRevoke(url); }, 90000);
              return;
            }
            return origRevoke(url);
          };

          var origAnchorClick = HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click = function(){
            if (this && this.href && this.download && String(this.href).indexOf('blob:') === 0 && hasNativeDownload()) {
              window.__pcpDeliverBlobDownload(this.href, this.download || 'document');
              return;
            }
            return origAnchorClick.call(this);
          };
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
}
