package chat.seance.app;

import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.util.WebColor;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The "stay connected" service's handle for the page (before the
        // bridge builds its plugin list).
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);

        // The paperclip's picker offers the camera too, as iOS's does.
        getBridge().getWebView().setWebChromeClient(new UploadChooserClient(getBridge()));

        // The window behind the WebView, in the deploy's colour
        // (capacitor.config.ts `backgroundColor`, from config.json's
        // themeColor). Capacitor paints the WebView itself in it; the window
        // stays the theme's white, and that is what shows wherever the
        // WebView does not reach: the status-bar and navigation-bar bands on a
        // WebView older than Chromium 140, which Capacitor insets natively
        // instead of handing the page the safe areas, and any frame before
        // the page paints.
        String color = getBridge().getConfig().getBackgroundColor();

        if (color != null) {
            try {
                getWindow().setBackgroundDrawable(new ColorDrawable(WebColor.parseColor(color)));
            } catch (IllegalArgumentException ignored) {
                // Not a colour: keep the theme's.
            }
        }
    }
}
