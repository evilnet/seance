package chat.seance.app

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.provider.MediaStore
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import java.io.File
import java.io.IOException
import java.util.Locale

/**
 * The composer's paperclip (`<input type="file">`) offers the camera as well
 * as the files, the way iOS's picker sheet does. wry's own chrome client
 * (generated/RustWebChromeClient.kt, rewritten on every build) opens the
 * camera only for an input with the `capture` attribute — which skips the
 * gallery — and otherwise hands the choice to the system document picker,
 * which has no camera in it. Here the same picker is wrapped in a chooser
 * with a photo and a video capture intent up front (EXTRA_INITIAL_INTENTS),
 * filtered by the input's accept list.
 *
 * It sits in front of wry's client and hands it everything else, an input
 * with `capture` included.
 *
 * No CAMERA permission is declared: an app that does not hold it may still
 * ask the camera app to take a picture for it (ACTION_IMAGE_CAPTURE), and
 * that is all this does. The shot lands in a cache file the FileProvider
 * (file_paths.xml) exposes; the manifest's <queries> makes the capture
 * actions resolvable on Android 11+.
 */
class UploadChooserClient(
    private val activity: WryActivity,
    private val inner: WebChromeClient,
) : WebChromeClient() {
    /** A capture the chooser offered: the intent, and the cache file it writes into. */
    private class Capture(val intent: Intent, val file: File)

    private var pending: ValueCallback<Array<Uri?>?>? = null
    private val pendingCaptures = mutableListOf<Capture>()

    override fun onShowFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri?>?>,
        params: FileChooserParams,
    ): Boolean {
        if (params.isCaptureEnabled) {
            return inner.onShowFileChooser(webView, callback, params)
        }

        val pick = params.createIntent()
        if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }

        val accept = params.acceptTypes.toList()
        pendingCaptures.clear()
        sweepStaleCaptures()
        offer(accept, "image/jpeg", MediaStore.ACTION_IMAGE_CAPTURE, "jpg", ".jpg", ".jpeg")
        offer(accept, "video/mp4", MediaStore.ACTION_VIDEO_CAPTURE, "mp4", ".mp4")

        val chooser = if (pendingCaptures.isEmpty()) {
            pick
        } else {
            Intent.createChooser(pick, null)
                .putExtra(Intent.EXTRA_INITIAL_INTENTS, pendingCaptures.map { it.intent }.toTypedArray())
        }

        pending?.onReceiveValue(null)
        pending = callback

        try {
            activity.launchActivityForResult(chooser) { onChosen(it) }
        } catch (e: RuntimeException) {
            pending = null
            callback.onReceiveValue(null)
        }

        return true
    }

    private fun onChosen(result: ActivityResult?) {
        val callback = pending
        val captures = pendingCaptures.toList()
        pending = null
        pendingCaptures.clear()

        if (callback == null) {
            return
        }

        // The camera apps were let into every placeholder by name (below):
        // the chooser has answered, so none of them keeps that.
        captures.forEach { activity.revokeUriPermission(uriFor(it.file), GRANT) }

        val ok = result?.resultCode == Activity.RESULT_OK
        val uris = picked(if (ok) result?.data else null)

        // A capture app answers OK with no Intent at all (given EXTRA_OUTPUT),
        // with an empty one, or with the output URI echoed back: in every
        // case the shot is in the file it was handed, and whichever
        // placeholder has content is the one that ran. Anything else picked
        // is a file from the picker.
        if (ok && (uris.isEmpty() || isCapture(uris, captures))) {
            uris.clear()
            takeCapture(captures)?.let { uris.add(it) }
        } else {
            // Backed out, or a file was picked: every placeholder is spare.
            captures.forEach { it.file.delete() }
            // A picker is another app, and what it answers is not trusted: a
            // file: URI, or one of this app's own FileProvider's, would have
            // the page upload the app's private files (its localStorage, the
            // saved passwords). Only another app's content is taken.
            uris.retainAll { it != null && fromAnotherApp(it) }
        }

        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    /** The files a picker result names: a multi-select clip, a single item, or none. */
    private fun picked(data: Intent?): MutableList<Uri?> {
        val uris = mutableListOf<Uri?>()
        val clip: ClipData? = data?.clipData

        if (clip != null) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let { uris.add(it) }
            }
        } else {
            data?.data?.let { uris.add(it) }
        }

        return uris
    }

    /** Does the result name one of the placeholders (a camera echoing EXTRA_OUTPUT)? */
    private fun isCapture(uris: List<Uri?>, captures: List<Capture>) =
        captures.any { uris.contains(uriFor(it.file)) }

    /** The capture that ran — the one placeholder with bytes in it. The spares go. */
    private fun takeCapture(captures: List<Capture>): Uri? {
        var taken: Uri? = null

        for (capture in captures) {
            if (taken == null && capture.file.length() > 0) {
                taken = uriFor(capture.file)
            } else {
                capture.file.delete()
            }
        }

        return taken
    }

    /** Add a capture placeholder to the chooser where the accept list admits it. */
    private fun offer(accept: List<String>, mime: String, action: String, extension: String, vararg suffixes: String) {
        if (accepts(accept, mime, *suffixes)) {
            captureIntent(action, extension)?.let { pendingCaptures.add(it) }
        }
    }

    /**
     * A content: URI whose provider is another app's. The provider is looked
     * up, not its name compared: an authority can carry a `user@` prefix,
     * and any of this app's providers would do as much harm as its own
     * FileProvider. This app always sees its own; another app's may be
     * hidden from it (package visibility), which still says it is not ours.
     */
    private fun fromAnotherApp(uri: Uri): Boolean {
        val authority = uri.authority ?: return false
        if (uri.scheme != "content" || '@' in authority) {
            return false
        }
        val owner = activity.packageManager.resolveContentProvider(authority, 0)?.packageName
        return owner != activity.packageName
    }

    private fun uriFor(file: File): Uri =
        FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)

    /** Yesterday's shots: the page has long read what it wanted. */
    private fun sweepStaleCaptures() {
        val cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000
        File(activity.cacheDir, "capture").listFiles()?.forEach {
            if (it.lastModified() < cutoff) {
                activity.revokeUriPermission(uriFor(it), GRANT)
                it.delete()
            }
        }
    }

    /** A capture writing into a fresh cache file, or null where no app answers it. */
    private fun captureIntent(action: String, extension: String): Capture? {
        val intent = Intent(action)
        val apps = activity.packageManager.queryIntentActivities(intent, 0)

        if (apps.isEmpty()) {
            return null
        }

        val file: File
        val output: Uri
        try {
            val dir = File(activity.cacheDir, "capture")
            if (!dir.isDirectory && !dir.mkdirs()) {
                return null
            }
            file = File.createTempFile("seance_", ".$extension", dir)
            output = uriFor(file)
        } catch (e: IOException) {
            return null
        } catch (e: IllegalArgumentException) {
            return null
        }

        intent.putExtra(MediaStore.EXTRA_OUTPUT, output)
        intent.addFlags(GRANT)
        // A chooser launches the nested intent itself, so the flags above may
        // not reach the camera app; grant it by name as well.
        for (app in apps) {
            activity.grantUriPermission(app.activityInfo.packageName, output, GRANT)
        }

        return Capture(intent, file)
    }

    // Everything else is wry's.

    override fun onShowCustomView(view: View, callback: CustomViewCallback) =
        inner.onShowCustomView(view, callback)

    override fun onHideCustomView() = inner.onHideCustomView()

    override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)

    override fun getDefaultVideoPoster(): Bitmap? = inner.defaultVideoPoster

    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) =
        inner.onJsAlert(view, url, message, result)

    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) =
        inner.onJsConfirm(view, url, message, result)

    override fun onJsPrompt(
        view: WebView,
        url: String,
        message: String,
        defaultValue: String,
        result: JsPromptResult,
    ) = inner.onJsPrompt(view, url, message, defaultValue, result)

    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
        inner.onGeolocationPermissionsShowPrompt(origin, callback)

    override fun onConsoleMessage(consoleMessage: ConsoleMessage) = inner.onConsoleMessage(consoleMessage)

    override fun onReceivedTitle(view: WebView, title: String) = inner.onReceivedTitle(view, title)

    override fun onProgressChanged(view: WebView, newProgress: Int) = inner.onProgressChanged(view, newProgress)

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message) =
        inner.onCreateWindow(view, isDialog, isUserGesture, resultMsg)

    companion object {
        private const val GRANT = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

        /**
         * Does this accept list admit a file of type `mime` (or one of its
         * `extensions`) — or anything at all? A capture is one fixed format,
         * so `image/png` alone does not admit the camera's JPEG; `image/` +
         * `*` does.
         */
        private fun accepts(accept: List<String>, mime: String, vararg extensions: String): Boolean {
            val family = mime.substring(0, mime.indexOf('/') + 1) + "*"

            for (type in accept) {
                val wanted = type.trim().lowercase(Locale.ROOT)

                if (wanted.isEmpty() || wanted == "*/*" || wanted == family || wanted == mime || wanted in extensions) {
                    return true
                }
            }
            return accept.isEmpty()
        }
    }
}
