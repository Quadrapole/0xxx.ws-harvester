// 0xxx harvest — per-tab hotkeys (c = arm this tab, s = copy links)
(function () {
  "use strict";
  const root = document.documentElement;
  if (root.dataset.ohx === "1") return; // another copy (e.g. Violentmonkey) owns the keys
  root.dataset.ohx = "1";

  function thumb() {
    const all = [...document.querySelectorAll("a[href]")];
    return (
      all.find((a) => /imagetwist|imageban|picsextra|imgbox|imgclick/i.test(a.href)) ||
      document.querySelector("table a[target='_blank']") ||
      null
    );
  }

  function dlButton() {
    return (
      document.querySelector("form button") ||
      [...document.querySelectorAll("button, input[type=submit]")].find((b) =>
        /show download/i.test(b.textContent || b.value || "")
      ) ||
      null
    );
  }

  function hosterLinks() {
    const cell =
      [...document.querySelectorAll("td, th")].find((c) =>
        /download links/i.test(c.textContent || "")
      )?.parentElement?.querySelectorAll("td")[1] || document.body;
    const m = cell.textContent.match(/https?:\/\/(rapidgator\.net|k2s\.cc)\/\S+/g) || [];
    return [...new Set(m.map((u) => u.replace(/[.,;)]+$/, "")))];
  }

  function openAndArm() {
    const a = thumb();
    if (a) {
      const link = document.createElement("a");
      link.href = a.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      flash("screen-cap: " + a.href.split("/")[2]);
    } else {
      flash("no screen-cap found ✗");
    }
    const b = dlButton();
    if (b) setTimeout(() => b.click(), 300);
    else flash("no download button ✗");
  }

  function copyLinks() {
    const us = hosterLinks();
    if (us.length) {
      navigator.clipboard.writeText(us.join("\n"));
      flash("copied " + us.length + " link(s) ✓ " + us.map((u) => u.split("/")[2]).join(","));
    } else {
      flash("no links visible — captcha solved?");
    }
  }

  let toast;
  function flash(msg) {
    if (!toast) {
      toast = document.createElement("div");
      toast.style.cssText =
        "position:fixed;z-index:999999;right:12px;bottom:12px;padding:8px 14px;" +
        "background:#0f766e;color:#fff;font:13px/1.4 system-ui;border-radius:8px;" +
        "box-shadow:0 2px 10px rgba(0,0,0,.4);max-width:60vw";
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.display = "none"), 3500);
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.target.closest("input,textarea,select")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") { e.preventDefault(); openAndArm(); }
      if (e.key === "s") { e.preventDefault(); copyLinks(); }
    },
    true
  );
})();
