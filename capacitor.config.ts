import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pcpinnov.patient",
  appName: "PCPTherapy",
  webDir: "www",
  ios: {
    contentInset: "never",
  },
  server: {
    url: "https://patient.pcpinnov.com/",
    androidScheme: "https",
    errorPath: "offline.html",
  },
};

export default config;
