package chirkle.android.nav

import androidx.compose.ui.res.stringResource
import chirkle.android.R
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import chirkle.android.data.lib.title
import chirkle.android.ui.ChirkleIcons

/** Where shared text and files go (§9.3): a room or DM to post them in. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SharePickerScreen(rooms: List<chirkle.android.data.model.Room>, me: String?, onPick: (String) -> Unit, onCancel: () -> Unit) {
    Scaffold(topBar = {
        TopAppBar(
            navigationIcon = { IconButton(onClick = onCancel) { Icon(ChirkleIcons.Close, contentDescription = stringResource(R.string.app_cancel)) } },
            title = { Text(stringResource(R.string.app_share_to)) },
        )
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding)) {
            items(rooms, key = { it.id }) { r -> ListItem(headlineContent = { Text(r.title(me)) }, leadingContent = { chirkle.android.ui.RoomPicture(r, me) }, modifier = Modifier.clickable { onPick(r.id) }) }
        }
    }
}
