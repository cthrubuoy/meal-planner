/* PWA service worker registration */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => {
      console.warn("SW registration failed:", err);
    });
  });

  // Auto-reload on new SW activation (simple update flow)
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
