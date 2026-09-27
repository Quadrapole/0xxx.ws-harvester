// 0xxx harvest — window-wide sweeps (Ctrl+Shift+E open, X arm, U send)
const ARTICLE = /0xxx\.(ws|st|me)\/articles\//;

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
        target: { tabId: t.id },
        func: findThumb,
      });
      if (thumb && thumb.result) {
        // screen-cap tab directly to the right of its article tab
        await chrome.tabs.create({
          windowId: win.id,
          index: t.index + 1 + inserted,
          url: thumb.result,
          active: false,
        });
        inserted++;
      }
    } catch (e) {
      console.warn("0xxx harvest: open failed", t.id, e);
    }
  }
  notify("ohx-open", "release-harvest", inserted + " screen-cap tab(s) opened");
}

async function armWindow() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  const articles = win.tabs.filter((t) => ARTICLE.test(t.url || ""));
  let armed = 0;
  for (const t of articles) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: clickDownload,
      });
      armed++;
    } catch (e) {
      console.warn("0xxx harvest: arm failed", t.id, e);
    }
    // no pacing delay — single-tab arm proved back-to-back is fine
  }
  // bring focus back to the first article tab so solving starts immediately
  if (articles.length) chrome.tabs.update(articles[0].id, { active: true });
  notify("ohx-arm", "release-harvest", armed + " tab(s) armed ✓ (modals render ~8-10s)");
}

// Browser fetches always carry Origin, which JD's 3128 rejects outright —
// so we post to the local jd-relay (127.0.0.1:3128, strips Origin) which
// forwards to the JD box's API.
const JD_ADDLINKS = "http://127.0.0.1:3128/linkgrabberv2/addLinks";
let rid = 1;

function notify(id, title, msg) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message: msg,
  });
}

// runs inside each article tab: pull BOTH hosters from the revealed cell.
// rapidgator is preferred; k2s is the fallback when rg is dead/missing.
const collect = () => {
  const cell =
    [...document.querySelectorAll("td, th")].find((c) =>
      /download links/i.test(c.textContent || "")
    )?.parentElement?.querySelectorAll("td")[1] || document.body;
  const m = cell.textContent.match(/https?:\/\/(rapidgator\.net|k2s\.cc)\/\S+/g) || [];
  const urls = [...new Set(m.map((u) => u.replace(/[.,;)]+$/, "")))];
  return {
    rg: urls.filter((u) => /rapidgator\.net/.test(u)),
    k2s: urls.filter((u) => /k2s\.cc/.test(u)),
  };
};

// rapidgator liveness probe: HTTP 200 = alive, 404 = deleted file.
// null = network error, treat as alive (don't drop on a hiccup).
const rgAlive = async (url) => {
  try {
    const r = await fetch(url, { redirect: "follow" });
    return r.status === 200 ? true : r.status === 404 ? false : null;
  } catch (e) {
    return null;
  }
};

async function sendLinks() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  const articles = win.tabs.filter((t) => ARTICLE.test(t.url || ""));
  // gather both hosters from every tab in parallel
  const perTab = await Promise.all(
    articles.map(async (t) => {
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: collect,
        });
        return r.result || { rg: [], k2s: [] };
      } catch (e) {
        console.warn("0xxx harvest: read failed", t.id, e);
        return { rg: [], k2s: [] };
      }
    })
  );
  // decide per release: alive rapidgator wins, k2s only as fallback
  const decisions = await Promise.all(
    perTab.map(async ({ rg, k2s }) => {
      if (rg.length) {
        const alive = await Promise.all(rg.map(rgAlive));
        const good = rg.filter((u, i) => alive[i] !== false);
        if (good.length) return { links: good, fallback: 0 };
        if (k2s.length) return { links: k2s, fallback: 1 };
        return { links: [], fallback: 0 };
      }
      return { links: k2s, fallback: k2s.length ? 1 : 0 };
    })
  );
  const links = [...new Set(decisions.flatMap((d) => d.links))];
  const fallbacks = decisions.reduce((a, d) => a + d.fallback, 0);
  if (!links.length) {
    notify("ohx-send", "release-harvest", "No revealed links found — solve captchas first?");
    return;
  }
  try {
    const res = await fetch(JD_ADDLINKS, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        apiVer: 1,
        url: "/linkgrabberv2/addLinks",
        params: [
          {
            links: links.join("\n"),
            autostart: true,
            extractPassword: null,
            priority: "DEFAULT",
            downloadPassword: null,
            destinationFolder: null,
            overwritePackagizerRules: false,
          },
        ],
        rid: rid++,
      }),
    });
    const txt = await res.text();
    if (res.ok && !txt.includes("BAD_PARAMETERS")) {
      const fb = fallbacks ? " (" + fallbacks + " via k2s fallback)" : "";
      notify("ohx-send", "release-harvest", links.length + " link(s) → JD ✓" + fb);
    } else {
      notify("ohx-send", "release-harvest", "JD rejected: " + txt.slice(0, 120));
    }
  } catch (e) {
    notify("ohx-send", "release-harvest", "JD unreachable: " + e.message);
  }
}

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "open-window") openWindow();
  if (cmd === "arm-window") armWindow();
  if (cmd === "send-links") sendLinks();
});
