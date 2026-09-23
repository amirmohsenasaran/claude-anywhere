# The phone app

The same app as on the desktop, built for iPhone and Android. A phone runs no Claude of
its own — there is no Node and no server on it — so the phone app is a window onto a
computer that does: you add your PC (or Mac) once, and from then on it opens straight
into that computer's sessions, files and dev servers.

It is the desktop shell's own Rust (`src-tauri/src/lib.rs`), built with Tauri 2's mobile
targets. What a phone cannot have — the tray, start-at-login, the bundled server — is
left out of the phone build; everything else is the same code.

> Already have the web version on your home screen? That keeps working. The app adds a
> real icon, its own list of computers, and links that open in the browser.

## Before either

- **The computer that runs Claude has to be reachable from the phone.** Same Wi-Fi, or
  Tailscale on both. On that computer, *Settings → About* lists the addresses it answers
  on — `http://192.168.1.20:7777`, `http://100.x.y.z:7777` — and the app password is the
  one in its `.env` (empty if you never set one).
- **Rust and Node 20** on the Mac you build with: <https://rustup.rs>, then this repo
  cloned and `npm install` run once.

Every command below is run from the repository root.

## iPhone (needs a Mac)

1. **Xcode** from the App Store. Open it once and let it install its components, then:
   ```sh
   xcode-select --install
   brew install cocoapods
   rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim
   ```
2. **Your Apple team.** A free Apple ID is enough to put the app on your own phone. In
   Xcode → *Settings → Accounts*, add your Apple ID; the team id is the ten characters
   next to *Personal Team* (or on developer.apple.com → *Membership*).
   ```sh
   export APPLE_DEVELOPMENT_TEAM=ABCDE12345
   ```
3. **Generate the Xcode project** (it lands in `src-tauri/gen/apple`, which is not
   committed — the script makes it the same way every time):
   ```sh
   npm run mobile -- init ios
   ```
4. **On the iPhone:** plug it in, tap *Trust*, and turn on *Settings → Privacy &
   Security → Developer Mode* (it restarts).
5. **Run it:**
   ```sh
   npm run mobile -- dev ios
   ```
   and pick your iPhone from the list — or `npm run mobile -- open ios` to open Xcode,
   choose the phone at the top and press ▶.
6. On first launch iOS asks to find devices on your local network: **Allow**. That is
   how it reaches the PC; without it the computer looks switched off.

With a free Apple ID the app expires after 7 days — run step 5 again to reinstall. A
paid developer account gives a year, and TestFlight.

## Android

1. **Android Studio.** In *Settings → Languages & Frameworks → Android SDK*, install the
   latest *SDK Platform*, and on *SDK Tools*: *Android SDK Build-Tools*, *NDK (Side by
   side)*, *Android SDK Command-line Tools* and *Platform-Tools*.
2. **Tell the tools where they are** (for zsh, in `~/.zshrc`):
   ```sh
   export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/$(ls -1 "$ANDROID_HOME/ndk" | tail -1)"
   ```
   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
3. **Generate the Android project:**
   ```sh
   npm run mobile -- init android
   ```
   This also lets release builds speak plain http — Android's template allows that only
   in debug builds, and the PC answers on `http://…:7777`.
4. **Put it on the phone,** one of:
   - **Plugged in:** turn on *Developer options → USB debugging* on the phone, then
     `npm run mobile -- dev android`.
   - **An APK:** `npm run mobile -- build android --debug --target aarch64`, then
     `adb install` the file it names — or copy it to the phone and open it (allow
     *Install unknown apps* for your file manager).
   - **No setup at all:** every change to the app is built by the *Mobile* workflow on
     GitHub; open the latest run and download the `claude-anywhere-android` artifact.

## Using it

1. Open the app: the list of computers is empty.
2. **Add a computer:** its address, a name, its app password. **Test** says who
   answered before anything is saved.
3. **Use** — and from then on the app opens straight into that computer.

Everything happens on that computer; the phone only shows it. Switch computers from
*Settings → Computers* inside the chat, or the account menu's *Which computer…*.

## Not there yet

- **Notifications.** The desktop turns a finished turn or a permission request into a
  system notification; the phone does not yet, because it has to be woken for it.
- **A signed release build** for the stores. The debug APK and a development-signed
  iPhone build are what this sets up.
