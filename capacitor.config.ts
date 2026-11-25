import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell for the same web build that ships as the PWA (`dist/`). No second UI codebase.
 * The app is served from capacitor://localhost (iOS) and https://localhost (Android); API calls go to the
 * production origin set at build time with VITE_API_ORIGIN (see docs/production/MOBILE.md).
 */
const config: CapacitorConfig = {
  appId: 'com.karigarai.due',
  appName: 'Due',
  webDir: 'dist',
  android: {
    // Default, stated explicitly: the server's CORS allow-list expects https://localhost.
    // (A WebView cannot be pointed at cleartext http in release builds.)
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: '#f3f6f8',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#f3f6f8',
      overlaysWebView: false,
    },
  },
};

export default config;
