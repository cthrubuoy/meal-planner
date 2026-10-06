/* =====================================================
   Meal Planner — Recipe Card Scan
   - Captures photo via camera / file input
   - Compresses image (reuses fileToCompressedDataURL from app.js)
   - POSTs to backend Worker
   - Renders confirmation dialog with low-confidence flagging
   - On submit, builds a meal object using the existing schema and saves
   ===================================================== */

(function () {
  // ---- CONFIG: change this to your deployed Worker URL ----
  const SCAN_ENDPOINT = "https://meal-planner-backend.meal-planner-backend.workers.dev/scan";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* Every scan-server request goes in the diagnostics log (Settings › Advanced):
     what was asked, how long it took, and why it failed (the server lists each
     Gemini attempt). The response is returned untouched. */
  const DETAILS = " — details in Settings › Advanced.";
  /* The scan server gives up on Gemini after 80 s; this is the app's own limit, in case the server can't answer */
  const SCAN_TIMEOUT_MS = 100000;
  const SLOW_MSG = "Gemini (Google) is slow or busy right now, so the scan didn't finish. Please try again in a few minutes.";
  /* Server reasons like "Gemini 524: error code: 524" → plain words */
  function scanReason(data){
    const r = String(data?.reason || data?.error || "");
    if (data?.error === "scan_timeout" || /Gemini 5\d\d|timed? ?out|524|504/i.test(r)) return SLOW_MSG;
    return r ? `Scan failed: ${r}` : "Scan failed.";
  }
  async function loggedFetch(kind, about, url, opts) {
    const t0 = Date.now();
    const sentKB = opts?.body ? Math.round(opts.body.length / 1024) : 0;
    logEvent("info", "scan", `${kind} started${about ? ` (${about})` : ""}`, { sentKB });   // no matching OK/failed line = interrupted (app closed?)
    let resp;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SCAN_TIMEOUT_MS);
    try {
      resp = await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      const timedOut = e?.name === "AbortError";
      logEvent("error", "scan", `${kind}: ${timedOut ? `no answer after ${SCAN_TIMEOUT_MS / 1000} s` : "couldn't reach the scan server"}${about ? ` (${about})` : ""}`, {
        error: String(e?.message || e), ms: Date.now() - t0, sentKB, online: navigator.onLine, visible: document.visibilityState
      });
      if (timedOut) e.timedOut = true;
      throw e;
    } finally { clearTimeout(timer); }
    resp.clone().json().then(d => {
      const ms = Date.now() - t0;
      if (!resp.ok || d?.error) {
        logEvent("error", "scan", `${kind} failed${about ? ` (${about})` : ""}: ${d?.reason || d?.error || "HTTP " + resp.status}`, {
          http: resp.status, error: d?.error, reason: d?.reason, attempts: d?.attempts, ms, sentKB
        });
      } else {
        const bits = [d.title && `"${d.title}"`, Array.isArray(d.ingredients) && `${d.ingredients.length} ingredients`, Array.isArray(d.steps) && `${d.steps.length} steps`, kind === "dish photo" && (d.dishPhoto ? "photo found" : "no photo found")].filter(Boolean);
        logEvent("info", "scan", `${kind} OK${about ? ` (${about})` : ""}${bits.length ? ": " + bits.join(", ") : ""}`, { ms, sentKB });
      }
    }).catch(() => logEvent("error", "scan", `${kind}: the reply wasn't readable (HTTP ${resp.status})${about ? ` (${about})` : ""}`, { ms: Date.now() - t0, sentKB }));
    return resp;
  }

  const scanModal = $("#scan-modal");
  const scanLoading = $("#scan-loading");
  const scanError = $("#scan-error");
  const scanFormWrap = $("#scan-form-wrap");
  const scanIngContainer = $("#scan-ingredients");

  let scanLastFile = null;          // remember for retry
  let scanSteps = [];
  let scanTagEditor = null;
  let scanImage = null;             // the meal photo chosen on the review screen (data URL)
  let scanSource = "";              // link it was imported from
  let scanSourceName = "";          // the brand printed on a scanned card (scan server v2.6+), e.g. "Gousto"

  /* ---- Show/hide modal sections ---- */
  function openScan() {
    scanModal.classList.add("open");
    scanModal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }
  function closeScan() {
    scanModal.classList.remove("open");
    scanModal.setAttribute("aria-hidden", "true");
    lockBodyScroll(false);   // stays locked if the Add sheet is still open
    showSection(null);
    scanLastFile = null;
    scanImage = null;
    scanSource = "";
    scanSourceName = "";
    photoChoices = [];
    const row = $("#scan-photo-row");
    if (row) row.hidden = true;
  }
  function showSection(which) {
    scanLoading.hidden = which !== "loading";
    scanError.hidden = which !== "error";
    scanFormWrap.hidden = which !== "form";
  }
  function showError(msg) {
    scanError.querySelector(".error-message").textContent = msg;
    showSection("error");
  }

  /* ---- Wire up entry: scan button -> file input -> scan ---- */
  $("#scan-card-btn")?.addEventListener("click", () => {
    $("#scan-file").click();
  });

  $("#scan-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";   // allow picking same file again
    if (!file) return;
    scanLastFile = file;
    await runScan(file);
  });

  $("#scan-retry")?.addEventListener("click", () => {
    if (scanLastFile) runScan(scanLastFile);
    else $("#scan-file").click();
  });
  $("#scan-error-close")?.addEventListener("click", closeScan);
  $("#scan-close")?.addEventListener("click", closeScan);
  $("#scan-cancel")?.addEventListener("click", closeScan);

  /* ---- Run a scan ---- */
  /* ============== Meal photo on the review screen ==============
     Scan: the dish photo cropped from the card (when the server finds one),
     the whole card, or none. Import: the page's photo, or none. Or choose a file. */
  let photoChoices = [];          // [{ key, label, src }]
  function setPhotoChoices(list, pick){
    photoChoices = list.filter(c => c.key === "none" || c.src);
    choosePhoto(pick && photoChoices.some(c => c.key === pick) ? pick : "none");
  }
  function choosePhoto(key){
    const c = photoChoices.find(x => x.key === key) || { key:"none", src:null };
    scanImage = c.src || null;
    const row = $("#scan-photo-row");
    row.hidden = false;
    const img = $("#scan-photo-preview");
    img.hidden = !scanImage;
    if (scanImage) img.src = scanImage;
    $("#scan-photo-opts").innerHTML = photoChoices.map(x =>
      `<button type="button" class="btn mini ${x.key === c.key ? "primary" : ""}" data-photo="${x.key}">${escapeHtml(x.label)}</button>`).join("")
      + `<button type="button" class="btn mini" data-photo="__file">Choose…</button>`;
    $$("[data-photo]", $("#scan-photo-opts")).forEach(b => b.addEventListener("click", () => {
      if (b.dataset.photo === "__file") $("#scan-photo-file").click();
      else choosePhoto(b.dataset.photo);
    }));
  }
  $("#scan-photo-file")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const src = await fileToCompressedDataURL(f);
    if (!src) return;
    photoChoices = photoChoices.filter(c => c.key !== "custom").concat({ key:"custom", label:"Your photo", src });
    choosePhoto("custom");
  });

  /* ============== Edit › "Take dish photo from a recipe card" (photo_only) ============== */
  $("#edit-card-photo")?.addEventListener("click", () => $("#edit-card-photo-file").click());
  $("#edit-card-photo-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    status("📷 Finding the dish photo…", 30000);
    const card = await fileToCompressedDataURL(file);
    if (!card){ status("Couldn't read that photo.", 4000); return; }
    let box = null;
    try {
      const resp = await loggedFetch("dish photo", state.meals.find(m => m.id === state.editingId)?.title || "", SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: card, mode: "photo_only" })
      });
      const data = await resp.json();
      box = Array.isArray(data?.dishPhoto) ? data.dishPhoto : null;
    } catch { /* offline: fall back to the whole photo */ }
    const src = box ? (await cropImageToDataURL(file, box)) || card : card;
    setEditPendingImage(src);
    status(box ? "✓ Dish photo found — press Save to keep it." : "Couldn't pick out the dish, so the whole photo is ready — press Save to keep it.", 6000);
  });

  /* ============== Import from a link (website, TikTok, Instagram…) ==============
     Needs the scan server's POST /import (Worker v2). The box only appears once
     /health lists it, so an older server simply hides the feature. */
  const SCAN_BASE = SCAN_ENDPOINT.replace(/\/scan$/, "");
  const importReady = fetch(`${SCAN_BASE}/health`)
    .then(r => r.json())
    .then(j => Array.isArray(j.endpoints) && j.endpoints.includes("POST /import"))
    .catch(() => false);
  importReady.then(ok => { const row = $("#link-import"); if (row) row.hidden = !ok; });

  const firstUrl = text => (String(text || "").match(/https?:\/\/[^\s<>"']+/) || [])[0] || "";

  async function runImport(url) {
    openScan();
    $("#scan-loading p").textContent = "Fetching the recipe from that link…";
    showSection("loading");
    scanLastFile = null;
    let resp, data;
    try {
      resp = await loggedFetch("link import", url, `${SCAN_BASE}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      data = await resp.json();
    } catch {
      showError("Couldn't reach the import server. Check your internet connection and try again.");
      return;
    } finally {
      $("#scan-loading p").textContent = "Scanning the recipe card…";
    }
    if (!resp.ok || data.error) {
      showError((data?.reason || `Import failed (${resp.status}). Try a screenshot and Scan instead.`) + DETAILS);
      return;
    }
    populateScanForm(data);
    scanSource = data.source || url;
    let pagePhoto = null;
    if (typeof data.image === "string" && data.image.startsWith("data:image/")) {
      try {
        const blob = await (await fetch(data.image)).blob();
        pagePhoto = await fileToCompressedDataURL(new File([blob], "recipe", { type: blob.type }));
      } catch { pagePhoto = null; }
    }
    setPhotoChoices([{ key:"page", label:"Photo from the page", src: pagePhoto }, { key:"none", label:"No photo" }], "page");
    showSection("form");
  }
  window.importRecipeFromUrl = runImport;

  $("#link-go")?.addEventListener("click", () => {
    const url = firstUrl($("#link-url").value);
    if (!url) { status("Paste a link starting with http…"); $("#link-url").focus(); return; }
    $("#link-url").value = "";
    runImport(url);
  });
  $("#link-url")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("#link-go").click(); } });

  /* Android share sheet → Meal Planner (manifest share_target, GET ./?share_url=…) */
  (function handleShare() {
    const p = new URLSearchParams(location.search);
    if (!p.has("share_url") && !p.has("share_text") && !p.has("share_title")) return;
    const url = firstUrl(p.get("share_url")) || firstUrl(p.get("share_text")) || firstUrl(p.get("share_title"));
    history.replaceState(null, "", location.pathname);
    if (!url) { status("Nothing to import in what was shared."); return; }
    importReady.then(ok => {
      if (!ok) { status("Importing from links isn't switched on yet (the scan server needs updating).", 6000); return; }
      openAddSheet();
      runImport(url);
    });
  })();

  async function runScan(file) {
    openScan();
    showSection("loading");

    let dataUrl;
    try {
      dataUrl = await fileToCompressedDataURL(file);
      if (!dataUrl) throw new Error("Couldn't process the image. Try another photo.");
    } catch (err) {
      showError(err.message || "Image processing failed.");
      return;
    }

    let resp, data;
    try {
      resp = await loggedFetch("card scan", "", SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl })
      });
    } catch (err) {
      showError((err?.timedOut ? SLOW_MSG : "Couldn't reach the scan server. Check your internet connection and try again.") + DETAILS);
      return;
    }

    try {
      data = await resp.json();
    } catch {
      showError((resp.status >= 520 ? SLOW_MSG : `The scan server returned an unexpected response (HTTP ${resp.status}).`) + DETAILS);
      return;
    }

    if (!resp.ok || data.error) {
      if (data?.error === "not_a_recipe_card") {
        showError("That doesn't look like a recipe card. Try a clearer photo of one.");
      } else if (data?.error === "image_too_large") {
        showError("That photo is too big — try a smaller one.");
      } else if (data?.error === "scan_failed" || data?.error === "scan_timeout") {
        showError(scanReason(data) + DETAILS);
      } else {
        showError(`Scan failed (${resp.status}). Please try again.` + DETAILS);
      }
      return;
    }

    populateScanForm(data);
    scanSourceName = typeof data.source === "string" ? data.source : "";
    let dish = null;
    if (Array.isArray(data.dishPhoto)) dish = await cropImageToDataURL(file, data.dishPhoto);
    setPhotoChoices([
      { key:"dish", label:"Dish photo", src: dish },
      { key:"card", label:"Whole card", src: dataUrl },
      { key:"none", label:"No photo" }
    ], dish ? "dish" : "none");
    showSection("form");
  }

  /* ---- Populate the confirmation form with extracted data ---- */
  function populateScanForm(data) {
    $("#scan-title").value = data.title || "";
    $("#scan-cook-mins").value = (typeof data.cookMins === "number") ? String(data.cookMins) : "";
    $("#scan-notes").value = data.notes || "";

    scanIngContainer.innerHTML = "";
    (data.ingredients || []).forEach(ing => addScanIngredientRow(ing));
    if (!data.ingredients?.length) addScanIngredientRow();

    scanSteps = Array.isArray(data.steps) ? data.steps.slice() : [];
    refreshScanSteps();

    if (!scanTagEditor) {
      scanTagEditor = tokenEditor($("#scan-tags-editor"), $("#scan-tags-input"));
    }
    scanTagEditor.set(data.tags || []);
  }

  function addScanIngredientRow(pref) {
    const row = $("#ingredient-template").content.firstElementChild.cloneNode(true);
    const [nameEl, typeEl, amtEl, unitEl, rmBtn] = row.children;

    if (pref) {
      nameEl.value = pref.name || "";
      typeEl.value = pref.type || "grams";
      amtEl.value = (pref.amount ?? "");
      unitEl.value = pref.unit || "";

      if (pref.confidence === "low") {
        row.classList.add("low-confidence");
        if (pref.note) {
          const note = document.createElement("div");
          note.className = "confidence-note";
          note.textContent = `⚠ ${pref.note}`;
          row.appendChild(note);
        }

        // when user edits a low-confidence row, clear the warning
        const clearWarning = () => {
          row.classList.remove("low-confidence");
          row.querySelector(".confidence-note")?.remove();
        };
        [nameEl, typeEl, amtEl, unitEl].forEach(el => el.addEventListener("input", clearWarning, { once: true }));
      }
    }

    rmBtn.addEventListener("click", () => row.remove());
    typeEl.addEventListener("change", () => syncIngredientRowType(row));
    syncIngredientRowType(row);

    scanIngContainer.appendChild(row);
  }

  $("#scan-add-ingredient")?.addEventListener("click", () => addScanIngredientRow());

  /* ---- Steps in scan form ---- */
  function refreshScanSteps() {
    renderSteps($("#scan-steps"), scanSteps, refreshScanSteps);
  }
  $("#scan-add-step")?.addEventListener("click", () => {
    addStepFromInput($("#scan-step-input"), scanSteps, refreshScanSteps);
  });
  $("#scan-step-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      addStepFromInput($("#scan-step-input"), scanSteps, refreshScanSteps);
    }
  });

  /* ---- Submit: convert to meal and save ---- */
  $("#scan-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const title = $("#scan-title").value.trim();
    if (!title) { alert("Please give the meal a name."); $("#scan-title").focus(); return; }

    const cookRaw = $("#scan-cook-mins").value.trim();
    let cookMins = cookRaw === "" ? null : Number(cookRaw);
    if (cookMins !== null && !isFinite(cookMins)) cookMins = null;
    if (cookMins !== null) cookMins = Math.max(0, Math.min(600, cookMins));

    const ingredients = [];
    $$(".ingredient-row", scanIngContainer).forEach(row => {
      const [n, t, a, u] = row.children;
      const name = n.value.trim();
      if (!name) return;
      let amount = Number(a.value);
      if (!isFinite(amount) || amount < 0) return;
      const type = t.value;
      if (type === "qty") amount = Math.max(0, Math.round(amount));
      const canon = canonicalName(name);
      let unit = singulariseUnitLabel(u.value.trim());
      if (type === "qty" && !unit) unit = "piece";
      ingredients.push({ name: canon, type, amount, unit });
    });
    if (!ingredients.length) {
      alert("Please add at least one valid ingredient before saving.");
      return;
    }

    const userTags = scanTagEditor?.get() || [];
    const autoTags = ingredientNamesToTags(ingredients);
    const tags = Array.from(new Set([...userTags, ...autoTags]));

    const meal = {
      id: uid(),
      title,
      image: scanImage ? { type:"data", src: scanImage } : null,
      fav: false,
      tags,
      ingredients,
      cookMins,
      steps: scanSteps.slice(),
      notes: ($("#scan-notes").value || "").trim()
    };
    const source = cleanSource(scanSource ? { url: scanSource } : { name: scanSourceName });
    if (source) meal.source = source;

    // push to global state and save
    state.meals.unshift(meal);
    await saveAll();

    renderMeals();
    renderShopping();
    populateCookSelect();
    updateIngredientSuggestions();
    refreshTagSuggestions();

    status(`✓ ${meal.title} added from scan`);
    closeScan();
    closeAddSheet();
    setView("meals");
  });

  /* ---- Esc closes modal ---- */
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && scanModal.classList.contains("open")) closeScan();
  });

  /* =====================================================
     STEPS-ONLY SCAN (back of card)
     - Triggered from Edit modal "Scan back of card" button
     - Different prompt mode, merges into the currently-editing meal
     ===================================================== */

  $("#edit-scan-steps")?.addEventListener("click", () => {
    $("#edit-scan-file").click();
  });

  $("#edit-scan-file")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await runStepsScan(file);
  });

  /* Runs in the background (v22): you can press Save (or close Edit) while it
     scans. If Edit is still open on the same meal, the steps go into the form
     as before; otherwise they're saved straight onto the meal, with Undo. */
  async function runStepsScan(file) {
    const mealId = state.editingId;
    if (!mealId) {
      alert("Please open a meal for editing first.");
      return;
    }
    const titleNow = () => state.meals.find(m => m.id === mealId)?.title || "this meal";
    status("Scanning the back of the card… You can save and carry on — the steps are added when it's done.", 8000);

    {
      let dataUrl;
      try {
        dataUrl = await fileToCompressedDataURL(file);
        if (!dataUrl) throw new Error("Couldn't process the image.");
      } catch (err) {
        logEvent("error", "scan", `back-of-card photo couldn't be prepared (${titleNow()})`, { error: String(err?.message || err) });
        status(`Image error: ${err.message || "couldn't process photo"}`, 4000);
        return;
      }

      let resp, data;
      try {
        resp = await loggedFetch("back-of-card scan", titleNow(), SCAN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl, mode: "steps_only" })
        });
      } catch {
        status(`Couldn't reach the scan server for "${titleNow()}". Check your connection` + DETAILS, 7000);
        return;
      }

      try { data = await resp.json(); }
      catch { status("Scan server returned an unexpected response.", 4000); return; }

      if (!resp.ok || data.error) {
        if (data?.error === "not_a_recipe_card") status("That doesn't look like a recipe-instructions page.", 5000);
        else status(`Scan of "${titleNow()}" failed: ${data?.reason || resp.status}` + DETAILS, 9000);
        return;
      }

      const newSteps = Array.isArray(data.steps) ? data.steps : [];
      if (!newSteps.length) {
        status("No cooking steps found on that photo.", 4000);
        return;
      }

      const formOpen = editModal?.classList.contains("open") && state.editingId === mealId;
      if (formOpen) fillForm(newSteps, data);
      else await saveToMeal(mealId, newSteps, data);
    }
  }

  /* Edit is still open on this meal: put the steps in the form (Save keeps them) */
  function fillForm(newSteps, data) {
    let replace = true;
    if (editSteps.length) {
      replace = confirm(
        `Found ${newSteps.length} cooking step${newSteps.length === 1 ? "" : "s"}.\n\n` +
        `This meal already has ${editSteps.length} step${editSteps.length === 1 ? "" : "s"}.\n\n` +
        `OK = replace existing steps with the scanned ones\n` +
        `Cancel = keep existing, add scanned to the end`
      );
    }
    if (replace) editSteps.length = 0;
    newSteps.forEach(s => editSteps.push(s));
    refreshEditSteps();
    if (typeof data.cookMins === "number" && !$("#edit-cook-mins").value.trim()){ $("#edit-cook-mins").value = String(data.cookMins); $("#edit-cook-mins").syncPicks?.(); }
    if (data.notes && !$("#edit-notes").value.trim()) $("#edit-notes").value = data.notes;
    status(`✓ Added ${newSteps.length} step${newSteps.length === 1 ? "" : "s"} from scan`, 3500);
  }

  /* Edit was saved or closed: save the steps onto the meal itself */
  async function saveToMeal(mealId, newSteps, data) {
    const meal = state.meals.find(m => m.id === mealId);
    if (!meal) { status("The scan finished, but that meal has been deleted.", 4000); return; }
    const before = { steps: (meal.steps || []).slice(), cookMins: meal.cookMins, notes: meal.notes };
    meal.steps = newSteps.slice();                       // the card is the source: replace (Undo restores)
    if (typeof data.cookMins === "number" && typeof meal.cookMins !== "number") meal.cookMins = data.cookMins;
    if (data.notes && !String(meal.notes || "").trim()) meal.notes = data.notes;
    const after = () => { renderMeals(); window.populateCookSelect?.(); refreshMealView(); window.renderToday?.(); };
    await saveAll(); after();
    const msg = `✓ ${newSteps.length} step${newSteps.length === 1 ? "" : "s"} added to "${meal.title}"`;
    if (before.steps.length) {
      showUndoToast(`${msg} (replaced ${before.steps.length})`, async () => {
        Object.assign(meal, before); await saveAll(); after();
        status(`Steps of "${meal.title}" restored`, 3000);
      }, 8000);
    } else {
      status(msg, 4500);
    }
  }
})();
