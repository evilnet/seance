package chat.seance.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * The composer's paperclip (`<input type="file">`) offers the camera as well
 * as the files, the way iOS's picker sheet does ("Take Photo or Video" /
 * "Photo Library" / "Choose File"). Capacitor's own chrome client opens the
 * camera only for an input with the `capture` attribute — which on both
 * platforms skips the gallery — and otherwise hands the choice to the
 * system document picker, which has no camera in it. Here the same picker
 * is wrapped in a chooser with a photo and a video capture intent up front
 * (EXTRA_INITIAL_INTENTS), filtered by the input's accept list.
 *
 * No CAMERA permission is declared: an app that does not hold it may still
 * ask the camera app to take a picture for it (ACTION_IMAGE_CAPTURE), and
 * that is all this does. The shot lands in a cache file the FileProvider
 * (file_paths.xml) exposes; the manifest's <queries> makes the capture
 * actions resolvable on Android 11+.
 *
 * An input with `capture` still goes Capacitor's way (super).
 */
public class UploadChooserClient extends BridgeWebChromeClient {
    private final Bridge bridge;
    private final ActivityResultLauncher<Intent> launcher;

    private ValueCallback<Uri[]> pending;
    private final List<Capture> pendingCaptures = new ArrayList<>();

    /** A capture the chooser offered: the intent, and the cache file it writes into. */
    private static final class Capture {
        final Intent intent;
        final File file;

        Capture(Intent intent, File file) {
            this.intent = intent;
            this.file = file;
        }
    }

    public UploadChooserClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
        this.launcher = bridge.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), this::onChosen);
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (params.isCaptureEnabled()) {
            return super.onShowFileChooser(webView, callback, params);
        }

        Intent pick = params.createIntent();
        if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        List<String> accept = Arrays.asList(params.getAcceptTypes());
        pendingCaptures.clear();
        sweepStaleCaptures();
        offer(accept, "image/", MediaStore.ACTION_IMAGE_CAPTURE, "jpg");
        offer(accept, "video/", MediaStore.ACTION_VIDEO_CAPTURE, "mp4");

        Intent chooser = pick;

        if (!pendingCaptures.isEmpty()) {
            List<Intent> extras = new ArrayList<>();

            for (Capture capture : pendingCaptures) {
                extras.add(capture.intent);
            }

            chooser = Intent.createChooser(pick, null).putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toArray(new Intent[0]));
        }

        if (pending != null) {
            pending.onReceiveValue(null);
        }
        pending = callback;

        try {
            launcher.launch(chooser);
        } catch (RuntimeException e) {
            pending = null;
            callback.onReceiveValue(null);
        }

        return true;
    }

    private void onChosen(ActivityResult result) {
        ValueCallback<Uri[]> callback = pending;
        List<Capture> captures = new ArrayList<>(pendingCaptures);
        pending = null;
        pendingCaptures.clear();

        if (callback == null) {
            return;
        }

        Intent data = result.getResultCode() == Activity.RESULT_OK ? result.getData() : null;
        List<Uri> uris = picked(data);

        if (uris.isEmpty() && data != null) {
            // A capture app answers OK with no data: the shot is in the file it
            // was handed. Whichever placeholder has content is the one that ran.
            Uri taken = takeCapture(captures);
            if (taken != null) {
                uris.add(taken);
            }
        } else {
            // Backed out, or a file was picked: every placeholder is spare.
            dropCaptures(captures);
        }

        callback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
    }

    /** The files a picker result names: a multi-select clip, a single item, or none. */
    private static List<Uri> picked(Intent data) {
        List<Uri> uris = new ArrayList<>();

        if (data == null) {
            return uris;
        }

        ClipData clip = data.getClipData();

        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) {
                    uris.add(uri);
                }
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        return uris;
    }

    /** The capture that ran -- the one placeholder with bytes in it. The spares go. */
    private Uri takeCapture(List<Capture> captures) {
        Uri taken = null;

        for (Capture capture : captures) {
            if (taken == null && capture.file.length() > 0) {
                taken = uriFor(capture.file);
            } else {
                capture.file.delete();
            }
        }

        return taken;
    }

    private static void dropCaptures(List<Capture> captures) {
        for (Capture capture : captures) {
            capture.file.delete();
        }
    }

    /** Does this accept list admit `prefix` -- or anything at all? */
    private static boolean accepts(List<String> accept, String prefix) {
        for (String type : accept) {
            String wanted = type.trim().toLowerCase(Locale.ROOT);

            if (wanted.isEmpty() || wanted.equals("*/*") || wanted.startsWith(prefix)) {
                return true;
            }
        }
        return accept.isEmpty();
    }

    /** Add a capture placeholder to the chooser where the accept list admits it. */
    private void offer(List<String> accept, String prefix, String action, String extension) {
        if (!accepts(accept, prefix)) {
            return;
        }

        Capture capture = captureIntent(action, extension);

        if (capture != null) {
            pendingCaptures.add(capture);
        }
    }

    private Uri uriFor(File file) {
        Activity activity = bridge.getActivity();
        return FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
    }

    /** Yesterday's shots: the page has long read what it wanted. */
    private void sweepStaleCaptures() {
        File[] old = new File(bridge.getActivity().getCacheDir(), "capture").listFiles();
        long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;

        if (old == null) {
            return;
        }

        for (File stale : old) {
            if (stale.lastModified() < cutoff) {
                stale.delete();
            }
        }
    }

    /** A capture writing into a fresh cache file, or null where no app answers it. */
    private Capture captureIntent(String action, String extension) {
        Activity activity = bridge.getActivity();
        PackageManager pm = activity.getPackageManager();
        Intent intent = new Intent(action);
        List<ResolveInfo> apps = pm.queryIntentActivities(intent, 0);

        if (apps.isEmpty()) {
            return null;
        }

        File file;
        Uri output;
        try {
            File dir = new File(activity.getCacheDir(), "capture");
            if (!dir.isDirectory() && !dir.mkdirs()) {
                return null;
            }
            file = File.createTempFile("seance_", "." + extension, dir);
            output = uriFor(file);
        } catch (IOException | IllegalArgumentException e) {
            return null;
        }

        intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        // A chooser launches the nested intent itself, so the flags above may
        // not reach the camera app; grant it by name as well.
        for (ResolveInfo app : apps) {
            activity.grantUriPermission(
                app.activityInfo.packageName,
                output,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        }

        return new Capture(intent, file);
    }
}
