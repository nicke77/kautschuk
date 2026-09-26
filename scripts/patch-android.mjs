import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const android = join(root, "android");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const manifestPath = join(android, "app/src/main/AndroidManifest.xml");
let manifest = readFileSync(manifestPath, "utf8");
if (!manifest.includes("usesCleartextTraffic")) {
  manifest = manifest.replace("<application", '<application android:usesCleartextTraffic="true"');
}
if (!manifest.includes("ACCESS_NETWORK_STATE")) {
  manifest = manifest.replace(
    "</manifest>",
    '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />\n    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />\n    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />\n</manifest>',
  );
}
writeFileSync(manifestPath, manifest);

const gradlePath = join(android, "app/build.gradle");
let gradle = readFileSync(gradlePath, "utf8");
if (!gradle.includes("Java-WebSocket")) {
  gradle = gradle.replace(
    "dependencies {",
    "dependencies {\n    implementation 'org.java-websocket:Java-WebSocket:1.5.7'\n    implementation 'androidx.activity:activity:1.11.0'",
  );
}
writeFileSync(gradlePath, gradle);

const main = walk(join(android, "app/src/main/java")).find((path) => path.endsWith("MainActivity.java"));
if (!main) throw new Error("MainActivity.java saknas");
const pkg = readFileSync(main, "utf8").match(/package\s+([\w.]+)/)?.[1];
if (!pkg) throw new Error("Hittade inte paketnamn i MainActivity");
writeFileSync(
  main,
  `package ${pkg};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import se.kautschuk.lan.KautschukLanPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KautschukLanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`,
);

const pluginDir = join(android, "app/src/main/java/se/kautschuk/lan");
mkdirSync(pluginDir, { recursive: true });
const plugin = readFileSync(join(root, "native/KautschukLanPlugin.java"), "utf8");
writeFileSync(join(pluginDir, "KautschukLanPlugin.java"), plugin);
console.log("Android-projektet är patchat för LAN.");
