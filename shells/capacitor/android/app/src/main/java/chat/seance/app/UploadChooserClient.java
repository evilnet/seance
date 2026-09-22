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
    private Uri pendingPhoto;
    private Uri pendingVideo;

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
        boolean anything = accept.isEmpty() || accept.contains("*/*") || (accept.size() == 1 && accept.get(0).isEmpty());
        List<Intent> extras = new ArrayList<>();
        pendingPhoto = null;
        pendingVideo = null;

        if (anything || accepts(accept, "image/")) {
            Intent photo = captureIntent(MediaStore.ACTION_IMAGE_CAPTURE, "jpg");
            if (photo != null) {
                pendingPhoto = photo.getParcelableExtra(MediaStore.EXTRA_OUTPUT);
                extras.add(photo);
            }
        }

        if (anything || accepts(accept, "video/")) {
            Intent video = captureIntent(MediaStore.ACTION_VIDEO_CAPTURE, "mp4");
            if (video != null) {
                pendingVideo = video.getParcelableExtra(MediaStore.EXTRA_OUTPUT);
                extras.add(video);
            }
        }

        Intent chooser = extras.isEmpty() ? pick : Intent.createChooser(pick, null);
        if (!extras.isEmpty()) {
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, extras.toArray(new Intent[0]));
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
        Uri photo = pendingPhoto;
        Uri video = pendingVideo;
        pending = null;
        pendingPhoto = null;
        pendingVideo = null;

        if (callback == null) {
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK) {
            // Backed out: both placeholders are empty and go.
            firstWithContent(photo, video);
            callback.onReceiveValue(null);
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();

        if (data != null && (data.getClipData() != null || data.getData() != null)) {
            // A file was picked: the capture placeholders stay empty.
            firstWithContent(photo, video);
        }

        if (data != null && data.getClipData() != null) {
            ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) {
                    uris.add(uri);
                }
            }
        } else if (data != null && data.getData() != null) {
            uris.add(data.getData());
        } else {
            // A capture app returns no data: the shot is in the file it was
            // handed. Whichever of the two has content is the one that ran.
            Uri taken = firstWithContent(photo, video);
            if (taken != null) {
                uris.add(taken);
            }
        }

        callback.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
    }

    private static boolean accepts(List<String> accept, String prefix) {
        for (String type : accept) {
            if (type.trim().toLowerCase(Locale.ROOT).startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /** A capture intent writing into a fresh cache file, or null where no app answers it. */
    private Intent captureIntent(String action, String extension) {
        Activity activity = bridge.getActivity();
        PackageManager pm = activity.getPackageManager();
        Intent intent = new Intent(action);
        List<ResolveInfo> apps = pm.queryIntentActivities(intent, 0);

        if (apps.isEmpty()) {
            return null;
        }

        Uri output;
        try {
            File dir = new File(activity.getCacheDir(), "capture");
            if (!dir.isDirectory() && !dir.mkdirs()) {
                return null;
            }
            // Yesterday's shots: the page has long read what it wanted.
            File[] old = dir.listFiles();
            long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
            if (old != null) {
                for (File stale : old) {
                    if (stale.lastModified() < cutoff) {
                        stale.delete();
                    }
                }
            }
            File file = File.createTempFile("seance_", "." + extension, dir);
            output = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
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

        return intent;
    }

    private File fileOf(Uri uri) {
        // content://<authority>/my_cache_images/capture/<name> → the cache file.
        List<String> segments = uri.getPathSegments();
        if (segments.size() < 2) {
            return null;
        }
        File file = bridge.getActivity().getCacheDir();
        for (int i = 1; i < segments.size(); i++) {
            file = new File(file, segments.get(i));
        }
        return file;
    }

    private Uri firstWithContent(Uri... candidates) {
        Uri found = null;
        for (Uri uri : candidates) {
            if (uri == null) {
                continue;
            }
            File file = fileOf(uri);
            if (found == null && file != null && file.length() > 0) {
                found = uri;
            } else if (file != null) {
                // The other capture's empty placeholder.
                file.delete();
            }
        }
        return found;
    }
}
