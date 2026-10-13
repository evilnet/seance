package chat.seance.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * A push notification's delete intent: the user swiped it away or cleared
 * the shade. {@link PushService} forgets what it posted there, so a push
 * arriving while the dismissal is still reaching the shade starts the
 * conversation's list over instead of bringing the dismissed messages back.
 */
public class PushDismissReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action != null && action.startsWith(PushService.ACTION_DISMISS + "\n")) {
            PushService.forget(action.substring(PushService.ACTION_DISMISS.length() + 1));
        }
    }
}
