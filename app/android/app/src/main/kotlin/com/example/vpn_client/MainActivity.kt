package com.example.vpn_client

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Bridges to Android's own always-on VPN screen.
 *
 * Android already ships a kill switch — "Always-on VPN" plus "Block
 * connections without VPN" — enforced by the OS itself, below every app. An
 * in-app one built on VpnService cannot match it: only one VpnService may be
 * active at a time, so there is always a gap between the tunnel stopping and a
 * blocking service starting, and traffic leaks through that gap.
 *
 * So instead of a weaker imitation, the app sends the user to the real thing.
 */
class MainActivity : FlutterActivity() {
    private companion object {
        const val CHANNEL = "com.example.vpn_client/system"
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "openVpnSettings" -> result.success(openVpnSettings())
                    "isAlwaysOnSupported" -> result.success(
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                    )
                    else -> result.notImplemented()
                }
            }
    }

    /**
     * Opens the VPN settings screen. Returns false when the OEM has no such
     * activity, so the UI can fall back to written instructions instead of
     * showing a button that does nothing.
     */
    private fun openVpnSettings(): Boolean {
        val candidates = listOf(
            Intent(Settings.ACTION_VPN_SETTINGS),
            // Some OEM builds only expose the generic wireless settings screen.
            Intent(Settings.ACTION_WIRELESS_SETTINGS),
        )

        for (intent in candidates) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(intent)
                return true
            } catch (_: ActivityNotFoundException) {
                // Try the next one.
            }
        }
        return false
    }
}
