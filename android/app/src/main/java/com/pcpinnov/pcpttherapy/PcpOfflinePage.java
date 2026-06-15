package com.pcpinnov.pcpttherapy;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.ViewParent;
import android.view.Window;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Page hors-ligne bundlée ({@code public/offline.html}), chargée par Capacitor via
 * {@code server.errorPath} quand la WebView ne peut pas joindre le serveur distant.
 */
public final class PcpOfflinePage {

    /** Canvas PCP — identique iOS {@code offlinePageBackground} (#F5F6F8). */
    public static final int BACKGROUND_COLOR = 0xFFF5F6F8;

    public static final String APP_URL = PcpOfflineBridge.APP_URL;

    private PcpOfflinePage() {}

    public static boolean isOfflineUrl(String url) {
        return url != null && url.contains("offline.html");
    }

    /** Applique fond clair, désactive overscroll et le dark mode WebView (comme iOS). */
    public static void configureWebView(WebView view) {
        if (view == null) {
            return;
        }
        view.setBackgroundColor(BACKGROUND_COLOR);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);

        paintAncestorBackgrounds(view, BACKGROUND_COLOR);
        applySystemChrome(view, true);

        WebSettings settings = view.getSettings();
        if (settings != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                settings.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                settings.setAlgorithmicDarkeningAllowed(false);
            }
        }
    }

    /** Restaure les réglages par défaut quand l'app quitte la page offline. */
    public static void clearWebView(WebView view) {
        if (view == null) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(view, null);
        view.setBackgroundColor(Color.TRANSPARENT);
        view.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        view.setVerticalScrollBarEnabled(true);
        applySystemChrome(view, false);
    }

    /** Injecte les insets système — {@code env(safe-area-inset-*)} est souvent 0 sur Android. */
    public static void injectSafeAreaInsets(WebView view) {
        if (view == null) {
            return;
        }
        ViewCompat.setOnApplyWindowInsetsListener(
            view,
            (v, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                pushSafeAreaToJs(view, bars.top, bars.bottom);
                return insets;
            }
        );
        ViewCompat.requestApplyInsets(view);
        pushSafeAreaFromWindow(view);
    }

    private static void pushSafeAreaFromWindow(WebView view) {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(view);
        if (insets == null) {
            return;
        }
        Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
        pushSafeAreaToJs(view, bars.top, bars.bottom);
    }

    private static void pushSafeAreaToJs(WebView view, int topPx, int bottomPx) {
        String js =
            "(function(){"
                + "if(window.__pcpSetSafeAreaInsets){"
                + "window.__pcpSetSafeAreaInsets("
                + topPx
                + ","
                + bottomPx
                + ");"
                + "}"
                + "document.documentElement.classList.add('pcp-offline-native');"
                + "})();";
        view.post(() -> view.evaluateJavascript(js, null));
    }

    private static void paintAncestorBackgrounds(WebView view, int color) {
        ViewParent parent = view.getParent();
        while (parent instanceof View ancestor) {
            ancestor.setBackgroundColor(color);
            if (ancestor.getId() == android.R.id.content) {
                break;
            }
            parent = ancestor.getParent();
        }
    }

    private static void applySystemChrome(WebView view, boolean offline) {
        Context ctx = view.getContext();
        if (!(ctx instanceof Activity activity)) {
            return;
        }
        Window window = activity.getWindow();
        if (window == null) {
            return;
        }
        View decor = window.getDecorView();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
        if (offline) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                window.setStatusBarColor(BACKGROUND_COLOR);
                window.setNavigationBarColor(BACKGROUND_COLOR);
            }
            if (controller != null) {
                controller.setAppearanceLightStatusBars(true);
                controller.setAppearanceLightNavigationBars(true);
            }
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
        if (controller != null) {
            controller.setAppearanceLightStatusBars(true);
            controller.setAppearanceLightNavigationBars(true);
        }
    }
}
