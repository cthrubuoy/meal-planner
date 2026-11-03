/* PWA service worker registration */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => {
      console.warn("SW registration failed:", err);
    });
  });

  // Reload onto a new version when its service worker takes over (simple update flow).
  // v35: not on a first visit (there was no old version: the new worker just claimed the page),
  // and never under an open form, meal page or cook mode: wait until it closes or the app is hidden.
  // (What's new doesn't count: the new version shows its own.)
  const hadController = !!navigator.serviceWorker.controller;
  const busy = () => !!document.querySelector(".modal.open:not(#whatsnew), .cook-overlay.open");
  let refreshing = false, waiting = false;
  const reloadWhenFree = () => {
    if (refreshing) return;
    if (busy() && document.visibilityState === "visible"){
      if (!waiting){
        waiting = true;
        // re-check whenever an overlay opens or closes (its class changes), or the app is hidden
        new MutationObserver(reloadWhenFree).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
        document.addEventListener("visibilitychange", reloadWhenFree);
      }
      return;
    }
    refreshing = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) reloadWhenFree();
  });
}
