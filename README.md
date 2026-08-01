# CoderIT Build Backend

Yeh backend "Build APK" feature ko power karta hai — Flutter project
ka zip leke, ek shared "builder" GitHub repo pe throwaway branch pe
push karta hai, phir **Codemagic** (free Hobby tier) se APK build
karwata hai, aur wapas app ko download link + realtime log lines deta
hai. GitHub token aur Codemagic API token kabhi bhi app tak nahi
jate — dono sirf yahan Render ke environment variables mein rehte hain.

Flow:
```
App (zip upload) -> yeh backend -> GitHub (builder repo, throwaway branch)
  -> Codemagic build -> backend (artifact fetch) -> App (download + log chips)
```

## 1. Ek shared "builder" repo banao

GitHub pe naya, chhota/khaali repo banao — e.g. `coderit-builder`
(private rakh sakte ho). Isme ek `codemagic.yaml` chahiye jo Android
build karta ho — Codemagic ke "Android native apps" quick-start guide
follow kar sakte ho:
https://docs.codemagic.io/yaml-quick-start/building-a-native-android-app/

Zaroori: workflow ka output ek `.apk` file honi chahiye (Codemagic ke
`artifacts:` section mein `app/build/outputs/**/*.apk` jaisa path).

## 2. Fine-grained GitHub token banao

GitHub → Settings → Developer settings → Fine-grained tokens →
Generate new token:
- Repository access: **Only** `coderit-builder`
- Permissions: **Contents: Read & Write** (Actions permission ab
  zaroori nahi — Codemagic build karta hai, GitHub Actions nahi)

## 3. Codemagic setup

1. https://codemagic.io pe signup karo (free Hobby plan — 500 build
   minutes/month).
2. `coderit-builder` repo ko Codemagic mein add karo (Apps → Add
   application).
3. Account settings → API token se apna Codemagic API token copy karo.
4. App add karne ke baad uska **App ID** (URL mein ya app settings
   mein dikhega) aur workflow ka **Workflow ID** (Workflow Editor mein,
   ya `codemagic.yaml` mein jo workflow key likha hai) note kar lo.

## 4. Render pe deploy karo

- GitHub pe is backend ka repo push karo.
- Render dashboard → New → Web Service → apna GitHub repo select karo.
- Build command: `npm install`
- Start command: `npm start`
- Environment variables set karo:

| Key | Value |
|---|---|
| `GITHUB_BUILD_TOKEN` | wo fine-grained token (Contents RW) |
| `GITHUB_BUILDER_REPO` | `your-username/coderit-builder` |
| `GITHUB_BUILDER_BASE_BRANCH` | `main` |
| `CODEMAGIC_API_TOKEN` | Codemagic account settings se mila token |
| `CODEMAGIC_APP_ID` | `coderit-builder` app ka Codemagic App ID |
| `CODEMAGIC_WORKFLOW_ID` | us app ke Android workflow ka ID |
| `PUBLIC_BASE_URL` | apka Render service ka public URL (deploy hone ke baad milega, e.g. `https://coderit-build-backend.onrender.com`) |
| `BUILD_API_KEY` | (optional) koi bhi secret string — set kiya to Flutter app ko `x-api-key` header mein bhejna hoga |

`PUBLIC_BASE_URL` deploy hone ke baad milta hai, isliye pehle bina
uske deploy karo, phir URL milne ke baad env var update karke
manual redeploy kar do.

## 5. Flutter app mein backend URL set karo

`lib/services/apk_build_service.dart` ke top pe:

```dart
const String kBuildBackendBase = 'https://coderit-build-backend.onrender.com';
```

Agar `BUILD_API_KEY` set kiya hai, requests mein header add karo:
```
x-api-key: <wahi secret>
```

## Endpoints

- `POST /api/build/start` — multipart form: `zip` file, optional `projectName`
- `GET /api/build/status/:buildId?since=<n>` — `since` diya to sirf
  index `n` ke baad ke naye log lines milte hain (poll-friendly tail);
  chhoda to poore log lines milte hain. Response mein `logs` (naye
  lines ka array) aur `logCount` (ab tak total lines) dono hote hain.
- `GET /api/build/download/:buildId`

## Notes

- Free Render plan pe backend spin-down ho sakta hai inactivity pe —
  pehli request thodi slow hogi, normal hai.
- Free Codemagic Hobby plan: 500 build minutes/month, single
  concurrent build — dusra build tabhi shuru hoga jab pehla khatam ho
  jaye.
- Build status abhi in-memory hai — Render restart hua to chalte
  build ka status miss ho sakta hai (Codemagic khud chalta rahega,
  bas status/logs app ko nahi milenge).
- Build log lines Codemagic ke `buildActions` (per-step status) se
  banti hain, na ki raw Gradle output — Codemagic API abhi live raw
  log text ka endpoint expose nahi karta.
- Auth abhi simplified hai (optional `BUILD_API_KEY` header check) —
  Firebase auth removed for simplicity.

