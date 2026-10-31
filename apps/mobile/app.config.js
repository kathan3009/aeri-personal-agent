// Production builds (EAS profile "production") talk only to the hosted HTTPS server, so they drop the local-network
// and cleartext permissions that development builds need to reach a laptop on the same Wi-Fi.
module.exports = ({ config }) => {
  if (process.env.EAS_BUILD_PROFILE !== 'production') return config;
  if (!process.env.EXPO_PUBLIC_API_URL?.startsWith('https://')) throw new Error('Set EXPO_PUBLIC_API_URL to the hosted https:// Aeri server for production builds.');
  const { NSLocalNetworkUsageDescription, NSAppTransportSecurity, ...infoPlist } = config.ios.infoPlist;
  return {
    ...config,
    ios: { ...config.ios, infoPlist: { ...infoPlist, ITSAppUsesNonExemptEncryption: false } },
    plugins: config.plugins.map(plugin => Array.isArray(plugin) && plugin[0] === 'expo-build-properties' ? ['expo-build-properties', { android: { usesCleartextTraffic: false } }] : plugin),
  };
};
