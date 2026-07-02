const { withInfoPlist, withAndroidManifest } = require('@expo/config-plugins');

const BONJOUR_SERVICE = '_openclaw-gw._tcp';

function withOpenClawDiscovery(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.NSLocalNetworkUsageDescription =
      config.modResults.NSLocalNetworkUsageDescription ??
      'Versutus discovers OpenClaw gateways on your local network.';
    const existing = config.modResults.NSBonjourServices ?? [];
    if (!existing.includes(BONJOUR_SERVICE)) {
      config.modResults.NSBonjourServices = [...existing, BONJOUR_SERVICE];
    }
    return config;
  });

  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest.$) manifest.$ = {};
    manifest.$['xmlns:android'] = manifest.$['xmlns:android'] ?? 'http://schemas.android.com/apk/res/android';
    const permissions = manifest['uses-permission'] ?? [];
    const required = [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.ACCESS_WIFI_STATE',
      'android.permission.CHANGE_WIFI_MULTICAST_STATE',
    ];
    for (const name of required) {
      if (!permissions.some((entry) => entry.$?.['android:name'] === name)) {
        permissions.push({ $: { 'android:name': name } });
      }
    }
    manifest['uses-permission'] = permissions;
    return config;
  });

  return config;
}

module.exports = withOpenClawDiscovery;