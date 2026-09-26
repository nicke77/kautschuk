# Kautschuk

Top-down drift för Android. Hela banan syns. Oljepölar belönar sladden. Upp till fyra spelare på samma Wi-Fi — en telefon är värd, de andra går med via adressen.

Poängen är gummi (hur länge och hur snyggt du sladdar), inte vem som kommer först i mål. Tre varv. Mellanslag eller knappen **Sladd** släpper bakhjulen.

## Ladda ner APK

1. Öppna [Releases](https://github.com/nicke77/kautschuk/releases).
2. Ladda ner `app-debug.apk` från senaste versionen.
3. På telefonen: tillåt installation från den här källan och installera.

Varje push till `main` bygger en ny APK. Samma fil ligger också som artifact under Actions om releasen inte syns än.

## Spela på nätverk

1. Båda telefonerna på **samma Wi-Fi**. Gästnät och AP-isolering blockerar telefon-till-telefon.
2. En trycker **Nätverk → Bli värd**. Adressen visas, till exempel `192.168.0.12:47821`.
3. De andra trycker **Gå med** och skriver adressen.
4. Värden trycker **Kör**.

Tangentbord: W gas, S broms, A vänster, D höger, mellanslag sladd.

## Bygga själv

```bash
npm ci
npm run build
npx cap add android
npx cap sync android
node scripts/patch-android.mjs
cd android && ./gradlew assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`
