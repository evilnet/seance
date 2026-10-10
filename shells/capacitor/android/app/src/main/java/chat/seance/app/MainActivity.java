package chat.seance.app;

import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.util.WebColor;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The "stay connected" service's handle for the page (before the
        // bridge builds its plugin list).
        registerPlugin(KeepAlivePlugin.class);
        // Contrast and animation settings, live (the WebView's own go stale).
        registerPlugin(SystemAccessibilityPlugin.class);
        super.onCreate(savedInstanceState);

        Bridge bridge = getBridge();

        // The paperclip's picker offers the camera too, as iOS's does.
        bridge.getWebView().setWebChromeClient(new UploadChooserClient(bridge));

        // Android's font size reaches the page as a number instead
        // (SystemAccessibilityPlugin, client/js/helpers/systemTextSize.ts),
        // which scales the whole interface. The WebView's own way, its text
        // zoom, scales glyphs and never rem lengths, so text outgrew the
        // buttons and fields around it; pinned at 100%, it does nothing. It
        // stays pinned with matchSystemTextSize off too: off is the in-app
        // step alone, as on iOS, not the glyph-only zoom back. The
        // activity declares fontScale (AndroidManifest.xml), so a change to
        // the setting does not relaunch it and take the connections with it.
        bridge.getWebView().getSettings().setTextZoom(100);

        // The window behind the WebView, in the deploy's colour
        // (capacitor.config.ts `backgroundColor`, from config.json's
        // themeColor). Capacitor paints the WebView itself in it; the window
        // stays the theme's white, and that is what shows wherever the
        // WebView does not reach: the status-bar and navigation-bar bands on a
        // WebView older than Chromium 140, which Capacitor insets natively
        // instead of handing the page the safe areas, and any frame before
        // the page paints.
        String color = bridge.getConfig().getBackgroundColor();

        if (color != null) {
            try {
                getWindow().setBackgroundDrawable(new ColorDrawable(WebColor.parseColor(color)));
            } catch (IllegalArgumentException ignored) {
                // Not a colour: keep the theme's.
            }
        }
    }
}
