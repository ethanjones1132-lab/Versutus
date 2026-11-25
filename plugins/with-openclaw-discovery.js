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
    // Gateways are reached over plain HTTP on LAN/tailnet, and the trusted
    // host set is only known at runtime (a LAN IP, a MagicDNS name). ATS cannot
    // express RFC 1918 ranges or a wildcard ts.net name, so this platform
    // exemption stays blanket: the real gate is the app's own predicate
    // (`isTrustedCleartextHost`, src/lib/gateway/security.ts), which refuses a
    // cleartext origin off the trusted local network before a profile is saved
    // or a request is built. Android's `usesCleartextTraffic` is the same kind
    // of blanket boolean (see app.json).
    config.modResults.NSAppTransportSecurity = {
      ...(config.modResults.NSAppTransportSecurity ?? {}),
      NSAllowsArbitraryLoads: true,
      NSAllowsLocalNetworking: true,
    };
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