package com.pcpinnov.pcpttherapy;

import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.Bridge;

/**
 * Intercepte {@code onShowFileChooser} (fallback si le hook JS click ne suffit pas).
 */
public class PcpWebChromeClient extends BridgeWebChromeClient {

    private final PcpFileUploadHandler fileUploadHandler;

    public PcpWebChromeClient(Bridge bridge, PcpFileUploadHandler fileUploadHandler) {
        super(bridge);
        this.fileUploadHandler = fileUploadHandler;
    }

    @Override
    public boolean onShowFileChooser(
        WebView webView,
        android.webkit.ValueCallback<android.net.Uri[]> filePathCallback,
        FileChooserParams fileChooserParams
    ) {
        if (fileUploadHandler != null && fileUploadHandler.handleShowFileChooser(filePathCallback, fileChooserParams)) {
            return true;
        }
        return super.onShowFileChooser(webView, filePathCallback, fileChooserParams);
    }
}
