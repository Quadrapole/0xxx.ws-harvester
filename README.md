# Zero-click captcha-to-download pipeline: browser release site → JDownloader (LAN)

*Built & verified 2026-09-13. Anonymized for sharing — replace `<JD-HOST>` with your JDownloader box's LAN IP.*

## The end result

Browsing a release site whose download links sit behind an hCaptcha ("Show download links" → captcha → revealed rapidgator/k2s links), normally a click-fest per release. Now the entire nightly session is **two hotkeys and the captcha solves themselves to you**:

1. Open the article tabs you want in one browser window.
2. **Ctrl+Shift+E** → every article tab gets its preview/screenshot in a tab directly to its **left** (preview freely — nothing is armed yet).
3. **Ctrl+Shift+K** → the download button is clicked on every article tab, arming all captchas (modal appears ~8–10 s after the click).
4. Solve the captchas (a solved tab's URL gains `#show`).
5. **Ctrl+Shift+U** → revealed rapidgator links are probed live, dead ones auto-swapped for their k2s twin, and the survivors are pushed to JDownloader on the LAN → desktop notification: *"N link(s) → JD ✓"*.

No right-click senders, no clipboard, no download-manager window. The human only solves captchas.

---

## Part 1 — JDownloader setup (one-time)

JDownloader runs headless in a Docker container (Unraid NAS), but any install works.

### 1a. Enable the LAN API ("Deprecated API")
1. JDownloader GUI (or the container's web desktop) → **Settings → Advanced Settings**, search box: `api`.
2. Find **`RemoteAPI: Deprecated Api Port`** — note the number (default **3128**).
3. **Uncheck `RemoteAPI: Deprecated Api Localhost Only`** ← this is the key setting; with it ticked, only the container itself can talk to the API.

### 1b. Publish the port in Docker
The container image only forwards ports you explicitly map (same place you mapped the web-UI port):
- Docker run: `-p 3128:3128`
- Unraid: Docker → container → Edit → **Add another Access Port** → host **3128** → container **3128** (TCP) → Apply (container restarts; downloads resume).

### 1c. Verify
```bash
curl "http://<JD-HOST>:3128/device/ping?rid=1"
# → {"data":true}
```

### 1d. Add links (the working request format)
```bash
curl -X POST -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "apiVer": 1,
    "url": "/linkgrabberv2/addLinks",
    "params": [{
      "links": "https://rapidgator.net/file/AAA\nhttps://rapidgator.net/file/BBB",
      "autostart": true,
      "extractPassword": null,
      "priority": "DEFAULT",
      "downloadPassword": null,
      "destinationFolder": null,
      "overwritePackagizerRules": false
    }],
    "rid": 1
  }' \
  "http://<JD-HOST>:3128/linkgrabberv2/addLinks"
# → {"data":{"id":1789288808457}}   = accepted
```

**Format gotchas (each cost us a debugging round):**
- `params` must be a **JSON array** (it maps onto the Java method signature). Send it as an object → `ClassCastException: … cannot be cast to JSonArray`.
- GET query-string params → `BAD_PARAMETERS`. It's POST-with-JSON-body only.
- Multiple URLs go in **one** `links` string joined by `\n` — one `addLinks` call per batch.
- The API is **unauthenticated and unencrypted** — keep 3128 LAN-only, never port-forward it.

### 1e. Traps we ruled out (don't bother)
| Route | Verdict |
|---|---|
| Port **3129** (every URL 501 / `API_COMMAND_NOT_FOUND`) | MyJDownloader **encrypted direct-connect tunnel** — speaks the cloud protocol, rejects plaintext. Wrong door for LAN scripting. |
| Legacy `/DeviceAction/?action=…` | Dead end on current builds. |
| **Flashgot** "Extern Interface" (port 9666 in Advanced Settings) | All paths 501. Dead end. |

### 1f. Quality-of-life JDownloader settings (used with this pipeline)
- **Auto-confirm dialogs** (`AutoConfirmManagerAutoStart = ENABLED`) → kills the "start downloads?" popup on headless boxes.
- **Duplicate links action = EXCLUDE** (`DefaultOnAddedDupesLinksAction`) → safe to re-send links; dupe batches are shrug-off-able.

### 1g. No-open-port fallback: the MyJDownloader **cloud** API
`https://api.jdownloader.org` accepts the same command set after an encrypted login (email + account password + app key; RSA+AES handshake). The Python library **myjdapi** wraps it nicely and works from anywhere — it's what an AI agent used before the LAN API was found. Note its API quirk: device objects come from `Myjdapi.get_device("<device name>")` and `linkgrabber.add_links()` takes **one dict with `\n`-joined links**. Cloud = zero new ports open but needs credentials in every client. LAN 3128 is credential-free — **but it rejects every request that carries an `Origin` header** (`AUTH_FAILED / Bad Origin`, hardcoded anti-webpage protection, no setting to disable), and browsers always stamp `Origin` on cross-origin POSTs. Scripts/curl work (no header); browser extensions must go through a tiny localhost relay — see **Part 1h**.

---

### 1h. Browser clients need a 2 KB localhost relay
The deprecated API rejects any request with an `Origin` header and browsers can't suppress it — so the extension posts to a **local relay** that forwards to 3128 with the header stripped. `jd-relay.py`:

```python
#!/usr/bin/env python3
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "http://<JD-HOST>:3128"     # JDownloader deprecated RemoteAPI
BIND = ("127.0.0.1", 3128)             # localhost only — never expose this
STRIP = {"origin", "referer", "connection"}

class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() not in STRIP:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                payload, status = r.read(), r.status
                ctype = r.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            payload, status = e.read(), e.code
            ctype = e.headers.get("Content-Type", "application/json")
        except Exception as e:
            payload, status, ctype = str(e).encode(), 502, "text/plain"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = _proxy
    def log_message(self, *a): pass

if __name__ == "__main__":
    ThreadingHTTPServer(BIND, Relay).serve_forever()
```

Autostart at login with a systemd **user** unit (`~/.config/systemd/user/jd-relay.service`):

```ini
[Unit]
Description=jd-relay: localhost bridge to JDownloader LAN API
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /path/to/jd-relay.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`systemctl --user daemon-reload && systemctl --user enable --now jd-relay`. Cost when idle: ~0% CPU, ~10 MB RAM (it sleeps in `accept()` until a request arrives).

## Part 2 — The browser extension (unpacked MV3)

A **userscript alone can never do this**: user scripts live per-tab and can't enumerate or operate sibling tabs (that discovery is what forced the extension).

Install: save the folder below → `brave://extensions` / `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the folder. (Re-click ↻ on the extension after any file edit.)

### `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "release-harvest",
  "version": "2.1",
  "description": "Ctrl+Shift+E open screen-caps for all article tabs, Ctrl+Shift+K arm downloads, Ctrl+Shift+U send links (rg probed, dead→k2s).",
  "icons": { "128": "icon128.png" },
  "permissions": ["tabs", "scripting", "notifications"],
  "host_permissions": [
    "https://0xxx.ws/*",
    "https://0xxx.st/*",
    "https://0xxx.me/*",
    "https://imagetwist.com/*",
    "https://rapidgator.net/*",
    "http://127.0.0.1:3128/*"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["https://imagetwist.com/*", "https://www.imagetwist.com/*"],
      "js": ["interstitial.js"],
      "run_at": "document_idle"
    }
  ],
  "commands": {
    "open-window": {
      "suggested_key": { "default": "Ctrl+Shift+E" },
      "description": "Open a screen-cap tab next to every article tab in this window"
    },
    "arm-window": {
      "suggested_key": { "default": "Ctrl+Shift+K" },
      "description": "Arm the download/captcha on every article tab in this window"
    },
    "send-links": {
      "suggested_key": { "default": "Ctrl+Shift+U" },
      "description": "Send all revealed links in this window to JDownloader"
    }
  }
}
```
**Hotkey gotchas:** `Ctrl+Alt+<letter>` is **invalid in Chrome command manifests on Linux** (normalized to AltGr+letter, extension refuses to load with `Invalid value for 'commands[…]'`). Desktop environments pre-grab some chords before the browser ever sees them — KDE's Spectacle owns `Ctrl+Shift+S` (screen capture). And **Brave/Chrome never assign their own defaults to extension commands**: `Ctrl+Shift+O` (Bookmark manager), `Ctrl+Shift+A` (Search tabs), `Ctrl+Shift+L` and `Ctrl+Shift+P` all come back with *empty* bindings from `chrome.commands.getAll()` — verified empirically. `E`, `F`, `U`, `K`, `X` come back assigned — but `X` later turned out runtime-eaten on the live desktop (never fired), so `getAll` assignment is necessary, not sufficient — and Chrome does NOT re-apply changed `suggested_key`s to an installed extension on reload: the binding from install time persists, so letter changes require remove + re-add (or manual rebind at brave://extensions/shortcuts), otherwise the new key never fires. Rebind everything at `brave://extensions/shortcuts`.

### `background.js`  *(set `JD_HOST`)*
```javascript
// window-wide arm sweep + send-to-JDownloader
const ARTICLE = /0xxx\.(ws|st|me)\/articles\//;
const JD_HOST = "10.0.0.2";                       // <-- your JDownloader LAN IP
// Browsers always send Origin, which JD's 3128 rejects outright — so the
// extension posts to the local jd-relay (127.0.0.1:3128, strips Origin; Part 1h).
const JD_ADDLINKS = "http://127.0.0.1:3128/linkgrabberv2/addLinks";
let rid = 1;

const findThumb = () => {
  const all = [...document.querySelectorAll("a[href]")];
  const a =
    all.find((x) => /imagetwist|imageban|picsextra|imgbox|imgclick/i.test(x.href)) ||
    document.querySelector("table a[target='_blank']");
  return a ? a.href : null;
};

const clickDownload = () => {
  const b =
    document.querySelector("form button") ||
    [...document.querySelectorAll("button, input[type=submit]")].find((x) =>
      /show download/i.test(x.textContent || x.value || "")
    );
  if (b) { b.click(); return "armed"; }
  return "no-button";
};

async function openWindow() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  const articles = win.tabs
    .filter((t) => ARTICLE.test(t.url || ""))
    .sort((a, b) => a.index - b.index);
  let inserted = 0;
  for (const t of articles) {
    try {
      const [thumb] = await chrome.scripting.executeScript({
        target: { tabId: t.id }, func: findThumb,
      });
      if (thumb && thumb.result) {
        // screen-cap tab directly to the LEFT of its article tab
        await chrome.tabs.create({
          windowId: win.id, index: t.index + inserted,
          url: thumb.result, active: false,
        });
        inserted++;
      }
    } catch (e) { console.warn("harvest: open failed", t.id, e); }
  }
  notify("open", "release-harvest", inserted + " screen-cap tab(s) opened");
}

async function armWindow() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  const articles = win.tabs.filter((t) => ARTICLE.test(t.url || ""));
  let armed = 0;
  for (const t of articles) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id }, func: clickDownload,
      });
      armed++;
    } catch (e) { console.warn("harvest: arm failed", t.id, e); }
    // no pacing needed — see "lessons" (back-to-back arming verified)
  }
  if (articles.length) chrome.tabs.update(articles[0].id, { active: true });
  notify("arm", "release-harvest", armed + " tab(s) armed ✓ (modals render ~8-10s)");
}

function notify(id, title, msg) {
  chrome.notifications.create(id, { type: "basic", iconUrl: "icon128.png", title, message: msg });
}

// runs inside each article tab: grab BOTH hosters from the revealed cell.
// rapidgator is preferred; k2s is the fallback when rg is dead/missing.
const collect = () => {
  const cell =
    [...document.querySelectorAll("td, th")].find((c) =>
      /download links/i.test(c.textContent || ""))
      ?.parentElement?.querySelectorAll("td")[1] || document.body;
  const m = cell.textContent.match(/https?:\/\/(rapidgator\.net|k2s\.cc)\/\S+/g) || [];
  const urls = [...new Set(m.map((u) => u.replace(/[.,;)]+$/, "")))];
  return {
    rg: urls.filter((u) => /rapidgator\.net/.test(u)),
    k2s: urls.filter((u) => /k2s\.cc/.test(u)),
  };
};

// rapidgator liveness probe: GET → 200 = alive, 404 = deleted file.
// null (network hiccup / odd status) = keep the link, don't drop on a maybe.
const rgAlive = async (url) => {
  try {
    const r = await fetch(url, { redirect: "follow" });
    return r.status === 200 ? true : r.status === 404 ? false : null;
  } catch (e) { return null; }
};

async function sendLinks() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  const articles = win.tabs.filter((t) => ARTICLE.test(t.url || ""));
  // grab both hosters from every tab in parallel
  const perTab = await Promise.all(articles.map(async (t) => {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: collect });
      return r.result || { rg: [], k2s: [] };
    } catch (e) { console.warn("harvest: read failed", t.id, e); return { rg: [], k2s: [] }; }
  }));
  // decide per release: alive rapidgator wins; k2s only when rg is dead/missing
  const decisions = await Promise.all(perTab.map(async ({ rg, k2s }) => {
    if (rg.length) {
      const alive = await Promise.all(rg.map(rgAlive));
      const good = rg.filter((u, i) => alive[i] !== false);
      if (good.length) return { links: good, fallback: 0 };
      if (k2s.length) return { links: k2s, fallback: 1 };
      return { links: [], fallback: 0 };
    }
    return { links: k2s, fallback: k2s.length ? 1 : 0 };
  }));
  const links = [...new Set(decisions.flatMap((d) => d.links))];
  const fallbacks = decisions.reduce((a, d) => a + d.fallback, 0);
  if (!links.length) {
    notify("send", "release-harvest", "No revealed links found — solve captchas first?");
    return;
  }
  try {
    const res = await fetch(JD_ADDLINKS, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        apiVer: 1,
        url: "/linkgrabberv2/addLinks",
        params: [{
          links: links.join("\n"),
          autostart: true,
          extractPassword: null,
          priority: "DEFAULT",
          downloadPassword: null,
          destinationFolder: null,
          overwritePackagizerRules: false,
        }],
        rid: rid++,
      }),
    });
    const txt = await res.text();
    const fb = fallbacks ? " (" + fallbacks + " via k2s fallback)" : "";
    res.ok && !txt.includes("BAD_PARAMETERS")
      ? notify("send", "release-harvest", links.length + " link(s) → JD ✓" + fb)
      : notify("send", "release-harvest", "JD rejected: " + txt.slice(0, 120));
  } catch (e) {
    notify("send", "release-harvest", "JD unreachable: " + e.message);
  }
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "arm-window") armWindow();
  if (cmd === "send-links") sendLinks();
});
```
*(Index math note: newly inserted tabs shift later tabs right — the `inserted` counter keeps every screenshot adjacent to its article.)*

*(v2.1 removed all per-tab hotkeys at the owner's request — the sweeps are window-level `commands`; `content.js` no longer exists.)*

### `interstitial.js`  *(image-host ad wall)*
```javascript
// The image host's fake camera/cover page only appears on a session's first
// visits; the real image page has no such button, so silent exit is normal.
(function () {
  "use strict";
  const RE = /continue to (your )?image/i;
  const deadline = Date.now() + 45000; // the wall can pop after an ad timer
  const timer = setInterval(() => {
    const el = [...document.querySelectorAll("button, a, input[type=button], input[type=submit]")]
      .find((x) => RE.test((x.textContent || x.value || "").trim()));
    if (el) { el.click(); clearInterval(timer); }
    else if (Date.now() > deadline || /\.(jpg|png)/i.test(document.title)) clearInterval(timer);
  }, 1500);
})();
```

### `icon128.png`
Any 128×128 PNG (notifications require an icon; ours is a solid teal circle generated in six lines of Python/zlib).

---

## Part 3 — Lessons learned (the traps, in order met)

1. **Userscripts can't touch sibling tabs.** Violentmonkey/Tampermonkey are per-tab sandboxes; window-wide automation needs an extension with `tabs` + `scripting` permissions.
2. **Sandboxed `window.open()` is silently popup-blocked.** The first userscript printed "opened ✓" while Brave had blocked the tab. Fix: run `@grant none` (keeps the keypress user-gesture in the page's world) and navigate via a **real `<a target="_blank">` click** — popup blockers let genuine anchor navigation through.
3. **Manifest hotkeys on Linux:** `Ctrl+Alt+<letter>` = AltGr → `Invalid value for 'commands[...]'` at load. Use `Ctrl+Shift+…`.
4. **"One captcha at a time" was a timing myth.** Captcha modals render **~8–10 s after** the button click; earlier "only the last tab's captcha survived" observations were checks made too soon. Verified: back-to-back arming of a whole window loads every modal.
5. **Armed modals expire** if left unsolved too long → solve promptly after sweeping.
6. **Browsers reuse closed tab IDs**, and this site marks solved articles by appending `#show` to the URL — both made the solved/unsolved audit trivially reliable (URL pattern check, no screenshot-reading).
7. **The site rotates which hoster column it teases** between loads — harvest whatever the solved tab reveals instead of assuming one hoster.
8. **The image host gates a session's first hits** behind a fake-camera "Continue to your image" wall — poll-and-click content script kills it.
9. **JDownloader's LAN API is the "Deprecated RemoteAPI" on 3128** with `Deprecated Api Localhost Only` unchecked + the port mapped; port **3129 is the encrypted cloud tunnel** and looks alive to every probe (that cost two debugging sessions). `params` as a JSON **array**, links `\n`-joined in one call, POST-only.
10. **Unraid/JD headless niceties:** auto-confirm popups ON, duplicate links = EXCLUDE, and remember any "missing from Downloads" package may already be auto-extracted to your output folder and archived — check before debugging.
11. **The LAN API hates browsers:** 3128 answers `AUTH_FAILED / Bad Origin` to any request carrying an `Origin` header (curl works, extensions don't — and Chrome's header-rewrite API won't strip it). Relay through localhost (Part 1h). Bonus: hoster liveness is one GET — rapidgator returns 200 for live files, 404 for deleted — so the sender probes before sending and falls back to the k2s twin only when the rapidgator link is confirmed dead.

## Replicate in 10 minutes
1. Uncheck `RemoteAPI: Deprecated Api Localhost Only` (JD Advanced Settings), map container port 3128, restart.
2. `curl http://<JD-HOST>:3128/device/ping?rid=1` → `{"data":true}`.
3. Install the relay (**Part 1h**) and start it.
4. Save the JS files + a PNG icon, set `JD_HOST` + your site matchers, Load unpacked.
5. Open some article tabs → **Ctrl+Shift+E** (caps) → **Ctrl+Shift+K** (arm) → solve → **Ctrl+Shift+U** → watch it hit JDownloader (dead rapidgator links auto-swap to their k2s twin).

*Before the extension existed, all of this ran through an AI browser agent driving the same DOM clicks in a three-stage protocol (arm → solve → deliver). The extension is just the parts of that protocol that never needed a brain.*
