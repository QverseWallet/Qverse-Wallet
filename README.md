# Qverse Wallet (Chrome Extension · MV3)

**Qverse is an open-source wallet for the Qubitcoin network.**
Minimal, retail-friendly UI, built as a Chrome Extension (Manifest V3) with a simple, auditable codebase. No telemetry, no trackers.

---

## ✨ Key Features
- **Chrome MV3** (Service Worker background).
- **Local encrypted vault** (password-based; PBKDF2 → AES-GCM).
- **Create / import accounts**, manage multiple addresses.
- **Transaction signing & send flow** with a confirmation step showing the real fee.
- **Lightweight UI** (popup) and a read-only options page.
- **Minimal permissions** (see `manifest.json`), privacy-first.

> ⚠️ **Back up every address separately.** There is no recovery phrase. Each
> address is an independent private key, so exporting one WIF does not let you
> recover the others. Save the WIF of every address you fund. Hierarchical
> derivation (BIP32/BIP39) is on the roadmap.

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

Chain constants (dust limit, minimum relay fee, address version bytes) are taken
from Qubitcoin's own node source rather than assumed, and are documented inline
in `popup/tx-math.js`.

---

## 🚀 Install (from source)
1. Clone or download this repository.
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).

The wallet icon should appear in your toolbar.

To confirm the secure key generator is active, open the popup, right-click →
**Inspect**, and run `coinjs.__secureRandom` in the console. It must return
`true`.

---

## 📂 Project Layout
```
Qverse-Wallet/
├─ manifest.json
├─ popup/               # UI (create/unlock, accounts, send), tx math, session gate
├─ background/          # service worker (broadcast, balances, message relay)
├─ options/             # read-only settings view
├─ offscreen/           # in-memory store for the unlocked session
├─ app/js/              # crypto primitives (hashing, ECDSA, AES) + secure-random.js
├─ test/                # regression suite
└─ README.md
```

---

## 🛠 Development

No build step. Load the repository directly as an unpacked extension.

```bash
npm test
```

Runs the regression suite (49 tests, no dependencies):

| Suite | Covers |
|---|---|
| `crypto-regression` | CSPRNG key generation — including a booby-trapped `Math.random` to prove it is never reached — key uniqueness, entropy, WIF/address round-trips, checksum rejection |
| `transaction` | Fee, change and coin-selection arithmetic, plus a check that the size estimate bounds a real signed transaction |
| `integrity` | Script load order, manifest references, host permissions, and that no key material is written to `chrome.storage` |
| `popup-smoke` | Loads the real scripts in the order `index.html` specifies and exercises startup |
| `vault` | Vault creation, password policy, session restore, and refusal to overwrite keys that failed to decrypt |

Use **Conventional Commits** (`feat:`, `fix:`, `chore:`) for clean history.

---

## 🔒 Permissions & Privacy
- Minimal MV3 permissions declared in `manifest.json`.
- `host_permissions` limited to the explorer, mining pool and price endpoints the wallet actually calls.
- No analytics, no tracking scripts. The CSP (`script-src 'self'`) blocks any external script.
- **Disclosure:** the dashboard shows a banner linking to CoinEx with a referral code (`?rc=qverse`). It is a plain link — nothing is tracked or sent from the extension — but the maintainers may receive a referral benefit if you sign up through it.

---

## 🙌 Based On / Credits
Qverse reuses portions and ideas from **OutCast3k/coinbin** (https://github.com/OutCast3k/coinbin), licensed under **MIT**.
Thanks to coinbin and related open-source crypto libraries (coinjs/ec primitives, hashing, etc.) for their contribution to the ecosystem.

> Third-party components remain under their respective licenses. Keep copyright headers and attribution.

---

## 🗺 Roadmap
- BIP32/BIP39 hierarchical derivation with a recovery phrase, so a single backup covers every address.
- Hardware-wallet integration (e.g., Ledger; opt-in blind signing).
- Full activity view with confirmations/unconfirmed balance.
- Network switcher & endpoint presets.
- i18n (EN/ES).
- Reproducible builds.
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

**Please do not open a public issue for security problems.** A public report on a
live wallet exposes users before a fix can reach them.

Report privately through **GitHub's private vulnerability reporting** on this
repository: go to the **Security** tab → **Report a vulnerability**. Only the
maintainers can see it.

Scope: this extension's code — MV3 service worker, popup, options page, offscreen
session helper, and the crypto primitives under `app/js/`.

Please give us a reasonable window to ship a fix before disclosing publicly, and
do not run exploits against other users' wallets.

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

- **OutCast3k/coinbin** — © 2014 OutCast3k — https://github.com/OutCast3k/coinbin — MIT License.
  Full licence text: [`app/js/LICENSE-coinbin.txt`](app/js/LICENSE-coinbin.txt).
