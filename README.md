# Qverse Wallet (Chrome Extension · MV3)

**Qverse is an open-source wallet for the Qubitcoin network.**
Minimal, retail-friendly UI, built as a Chrome Extension (Manifest V3) with a simple, auditable codebase. No telemetry, no trackers.

---

## 🔐 Verify Extension Integrity

The Chrome Web Store version is built from this exact source code. You can verify it:

### Current Version: v0.3.2
**SHA256:** `9B12B5DA5E0545106E3140F528BC6610FE857A5EAB20205748C288656D5E5CC1`

### How to Verify:
1. Clone this repository:
   ```bash
   git clone https://github.com/QverseWallet/Qverse-Wallet.git
   ```
2. Create a ZIP of the extension:
   ```bash
   # Windows (PowerShell)
   Compress-Archive -Path "Qverse-Wallet\*" -DestinationPath "qverse-wallet.zip"
   
   # Linux/Mac
   cd Qverse-Wallet && zip -r ../qverse-wallet.zip .
   ```
3. Calculate the SHA256 hash:
   ```bash
   # Windows (PowerShell)
   Get-FileHash qverse-wallet.zip -Algorithm SHA256
   
   # Linux/Mac
   sha256sum qverse-wallet.zip
   ```
4. Compare with the hash above. If they match, the code is identical.

---

## ✨ Key Features
- **Chrome MV3** (Service Worker background).
- **Local encrypted vault** (password-based; PBKDF2 → AES-GCM).
- **Create / import accounts**, manage multiple addresses.
- **Transaction signing & send flow.**
- **Lightweight UI** (popup) and basic options.
- **Minimal permissions** (see `manifest.json`), privacy-first.

> **Security disclaimer:** Early-stage, community software. Always test with small amounts first. You are responsible for securing your keys and environment.

---

## 🧱 Architecture (High Level)
- **`manifest.json`** — MV3 entry point & permissions.
- **Background (Service Worker)** — broadcast, balance lookups, message relay to the offscreen document.
- **Popup UI** — create/unlock vault, accounts, send flow.
  - `popup/tx-math.js` — transaction sizing, coin selection and fee arithmetic (integer satoshis, unit-tested).
  - `popup/session-gate.js` — auth/wallet visibility and auto-lock enforcement.
- **Options page** — read-only view of the endpoints in use and the current auto-lock setting.
- **Offscreen document** — the only place unlocked keys live, with a session TTL. Nothing is written to disk.
- **Crypto libs (`app/js/`)** — ECDSA/secp256k1, hashing (SHA-256/RIPEMD-160/SHA-512), AES, PBKDF2.
  - `app/js/secure-random.js` — **must load last.** Replaces coinbin's `Math.random()` entropy with `crypto.getRandomValues`.

### Security Model
- **Password-derived key** via PBKDF2-SHA256 (600k iterations) with a per-vault **salt**, used for **AES-GCM** encryption with a random **IV**. Vaults written by older versions are migrated on unlock.
- **Private keys come from `crypto.getRandomValues`**, rejection-sampled into the valid secp256k1 range. The wallet refuses to generate a key if `secure-random.js` is not active.
- **Minimum 8-character vault password**, with a confirmation field at creation.
- **Session keys live only in the offscreen document's memory.** Nothing key-related is written to `chrome.storage`; if the document is torn down the session fails closed and the password is required again.
- **All secrets stay local.** Only the explorer, pool and price endpoints pinned in `host_permissions` are contacted.
- **Strict CSP** and minimal permissions to reduce attack surface.

### Tests

```bash
npm test
```

Covers CSPRNG key generation (including a booby-trapped `Math.random` to prove it is never reached), WIF/address round-trips, transaction fee and change arithmetic against real signed transactions, and packaging integrity.

> **Hardening ideas (roadmap):** BIP32/BIP39 hierarchical derivation with a recovery phrase (today each address is an independent key and must be backed up individually), reproducible builds, third-party audit.

---

## 🚀 Install (from source)
1. Clone or download this repository.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
   - If you introduce a build step later, load the `dist/` folder instead.

The wallet icon should appear in your toolbar.

---

## 📂 Typical Project Layout
```
Qverse-Wallet/
├─ manifest.json
├─ popup/               # UI (create/unlock, accounts, send)
├─ background/          # service worker
├─ options/             # configuration page
├─ offscreen/           # crypto/session helpers (optional)
├─ app/
│  └─ js/               # crypto primitives (hashing, ECDSA, AES, PBKDF2)
└─ README.md
```

> Keep any legacy/demo third-party code outside the packaged build (e.g., under `third_party/`) and retain the original licenses.

---

## 🛠 Development
- No build is strictly required. If you later add bundling:
  ```bash
  npm i
  npm run build
  ```
- Load `dist/` as the unpacked extension after building.
- Use **Conventional Commits** (`feat:`, `fix:`, `chore:`) for clean history.

---

## 🔒 Permissions & Privacy
- Minimal MV3 permissions declared in `manifest.json`.
- `host_permissions` limited to necessary explorer/RPC endpoints.
- No analytics, no tracking scripts.

---

## 🙌 Based On / Credits
Qverse reuses portions and ideas from **OutCast3k/coinbin** (https://github.com/OutCast3k/coinbin), licensed under **MIT**.
Thanks to coinbin and related open-source crypto libraries (coinjs/ec primitives, hashing, etc.) for their contribution to the ecosystem.

> Third-party components remain under their respective licenses. Keep copyright headers and attribution.

---

## 🗺 Roadmap
- Hardware-wallet integration (e.g., Ledger; opt-in blind signing).
- Full activity view with confirmations/unconfirmed balance.
- Network switcher & endpoint presets.
- i18n (EN/ES).
- Unit tests for crypto utilities and transaction builders.
- Security review / external audit.

---

## 🤝 Contributing
1. Open an Issue for bugs or feature requests.
2. Fork the repo and create a branch: `feat/<name>` or `fix/<name>`.
3. Use Conventional Commits and keep PRs small and focused.
4. If a change affects the UI, include screenshots.

By contributing, you agree your contributions are licensed under this repository’s MIT license.

---

## 🛡 Security Policy
If you discover a vulnerability, please report it **responsibly**:
- Prefer a GitHub Issue labeled `security` (avoid pasting sensitive details publicly).
- Alternatively, email the maintainers (add a contact in your fork).

We aim to acknowledge reports within **7 days** and provide a remediation plan as soon as feasible.
Scope: this extension’s code (MV3 service worker, popup, options, offscreen/crypto helpers) and build scripts in this repo.

**Please do not** disclose 0-days publicly before coordination or submit exploits targeting end-users.

---

## 📜 License (MIT)

```
MIT License

Copyright (c) 2025 QverseWallet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### NOTICE
This project includes or is based on components licensed under MIT:

- **OutCast3k/coinbin** — © respective authors — https://github.com/OutCast3k/coinbin — MIT License.

The MIT license text for these components is available in their respective repositories.
