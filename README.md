# DAN Chat – WhatsApp-style Chat App (Web + Android)

Stack: Vite (vanilla JS) + Firebase (Auth, Firestore, Hosting) + Capacitor (Android).
No Firebase Storage / Blaze plan needed: photos (compressed) and voice messages (max 30 sec) are saved inside Firestore.

Features: email/password login, one-to-one chat, group chat, photo sharing,
voice messages, online status, dark/light mode.

## 1. Firebase setup
1. https://console.firebase.google.com -> create project "DAN Chat"
2. Add a Web app, copy the config
3. Authentication -> Sign-in method -> enable Email/Password
4. Firestore Database -> create (production mode, e.g. asia-south1) -> Rules tab -> paste `firestore.rules`
5. Open `firebase-config.js` and paste your real keys

## 2. Run locally
    npm install
    npm run serve        # http://localhost:5173

## 3. Deploy website
    npm run build
    npm install -g firebase-tools
    firebase login
    firebase init hosting     # public dir: dist, SPA: yes, overwrite index.html: NO
    firebase deploy --only hosting
    # (rules too:) firebase deploy --only firestore:rules

## 4. Android APK
    npm run build:web
    npx cap add android
    npx cap sync android
    npx cap open android      # Build > Build APK(s) in Android Studio

For voice messages on Android, add to `android/app/src/main/AndroidManifest.xml`:

    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

Run `npx cap sync android` again after every `npm run build:web`.

## Notes
- Phone-number login needs reCAPTCHA + Blaze plan; this starter uses Email/Password.
- Change `appId` in `capacitor.config.ts` before publishing to Play Store.
