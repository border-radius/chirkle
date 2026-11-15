// Downloading an attachment (DESIGN.md §17.7) with the system's download manager, for the room and the viewer.
package chirkle.android.ui

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment

/**
 * Download [url] as [name] into Downloads, with the system's notification. Before Android 10 the shared Downloads
 * folder needs the storage permission, which the app doesn't ask for: the file goes to the app's own Downloads
 * folder there (the notification still opens it). Says what happened in a toast; false if it couldn't start.
 */
fun download(context: Context, url: String, name: String): Boolean {
    val file = name.replace('/', '_').replace('\u0000', '_').ifBlank { "file" }
    val ok = runCatching {
        // Not core-ktx's toUri (lint's UseKtx): this module has core-ktx only in debug builds, by Compose's tooling.
        val req = DownloadManager.Request(Uri.parse(url))
            .setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        if (Build.VERSION.SDK_INT >= 29) req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, file)
        else req.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, file)
        (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
    }.isSuccess
    android.widget.Toast.makeText(context, if (ok) context.getString(R.string.ui_downloading, name) else context.getString(R.string.ui_couldnt_download, name), android.widget.Toast.LENGTH_SHORT).show()
    return ok
}
