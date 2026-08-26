package com.placeholder.neonserpent;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * The Capacitor shell, plus the only two things the web layer cannot do for
 * itself.
 *
 * Measured on a Galaxy A73 5G: the status bar and the three-button navigation
 * bar were taking 30 css px vertically and 84 horizontally out of an 854x384
 * viewport - 8.5% of the game's linear scale - because in landscape the display
 * cutout and the nav bar sit BESIDE the game rather than above and below it.
 *
 * Two separate fixes are needed and they are often confused:
 *
 *  - hiding the bars (setDecorFitsSystemWindows + the insets controller) stops
 *    the system drawing over the window, and
 *  - LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES lets the window extend INTO the
 *    cutout instead of being letterboxed away from it.
 *
 * Without the second, `env(safe-area-inset-*)` reports 0 on a phone that
 * plainly has a notch, because the window never reaches it - which is exactly
 * what the on-device gate observed before this existed. With it, the page gets
 * real insets from its `viewport-fit=cover` and insets the design box itself
 * (see Viewport.resize); backgrounds still paint under the cutout.
 *
 * The bars come back transiently on a swipe from the edge and hide themselves
 * again, which is the required behaviour for a full-screen game - an app may
 * not permanently deny the user the navigation bar.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        goEdgeToEdge();
    }

    /**
     * Re-apply on regaining focus.
     *
     * Anything that takes focus - the notification shade, a permission dialog,
     * the recents switcher - restores the system bars on the way out. Without
     * this the game silently loses the 8.5% again the first time the player
     * pulls the shade down.
     */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            goEdgeToEdge();
        }
    }

    private void goEdgeToEdge() {
        // API 28+. Guarded rather than declared in the manifest because minSdk
        // here is 22, and a runtime guard is clearer about who it is for.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams params = getWindow().getAttributes();
            params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(params);
        }

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
    }
}
