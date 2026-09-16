// 0xxx harvest — auto-click ImageTwist "Continue to your image" interstitial.
// The fake camera/cover page only appears on the session's first imagetwist
// hit(s); the real image page has no such button, so silent exit is normal.
(function () {
  "use strict";
  const RE = /continue to (your )?image/i;
  const deadline = Date.now() + 45000; // interstitial can pop after an ad timer

  const timer = setInterval(() => {
    const el = [...document.querySelectorAll("button, a, input[type=button], input[type=submit]")]
      .find((x) => RE.test((x.textContent || x.value || "").trim()));
    if (el) {
      el.click();
      clearInterval(timer);
    } else if (Date.now() > deadline || document.title.includes(".jpg") || document.title.includes(".png")) {
      // real image page (title = filename) or timed out
      clearInterval(timer);
    }
  }, 1500);
})();
