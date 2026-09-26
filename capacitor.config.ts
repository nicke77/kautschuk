import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "se.kautschuk.app",
  appName: "Kautschuk",
  webDir: "dist",
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
  },
  server: {
    androidScheme: "http",
    cleartext: true,
  },
};

export default config;
