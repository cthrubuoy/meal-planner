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
      + `<button type="button" class="btn mini" data-photo="__file">📁 Choose…</button>`;
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
      const resp = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: card, mode: "photo_only" })
      });
      const data = await resp.json();
      box = Array.isArray(data?.dishPhoto) ? data.dishPhoto : null;
    } catch { /* offline: fall back to the whole photo */ }
    const src = box ? (await cropImageToDataURL(file, box)) || card : card;
    setEditPendingImage(src);
    status(box ? "✓ Dish photo found — press Save changes to keep it." : "Couldn't pick out the dish, so the whole photo is ready — press Save changes to keep it.", 6000);
  });
  $("#edit-photo-undo")?.addEventListener("click", () => setEditPendingImage(null));

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
      resp = await fetch(`${SCAN_BASE}/import`, {
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
      showError(data?.reason || `Import failed (${resp.status}). Try a screenshot and Scan instead.`);
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
    setPhotoChoices([{ key:"page", label:"🖼️ Photo from the page", src: pagePhoto }, { key:"none", label:"No photo" }], "page");
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
      resp = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl })
      });
    } catch (err) {
      showError("Couldn't reach the scan server. Check your internet connection and try again.");
      return;
    }

    try {
      data = await resp.json();
    } catch {
      showError("The scan server returned an unexpected response.");
      return;
    }

    if (!resp.ok || data.error) {
      if (data?.error === "not_a_recipe_card") {
        showError("That doesn't look like a recipe card. Try a clearer photo of one.");
      } else if (data?.error === "image_too_large") {
        showError("That photo is too big — try a smaller one.");
      } else if (data?.error === "scan_failed") {
        showError(`Scan failed: ${data.reason || "unknown error"}`);
      } else {
        showError(`Scan failed (${resp.status}). Please try again.`);
      }
      return;
    }

    populateScanForm(data);
    let dish = null;
    if (Array.isArray(data.dishPhoto)) dish = await cropImageToDataURL(file, data.dishPhoto);
    setPhotoChoices([
      { key:"dish", label:"🍽️ Dish photo", src: dish },
      { key:"card", label:"🃏 Whole card", src: dataUrl },
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
      notes: [($("#scan-notes").value || "").trim(), scanSource ? `Source: ${scanSource}` : ""].filter(Boolean).join("\n")
    };

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

  async function runStepsScan(file) {
    if (!state.editingId) {
      alert("Please open a meal for editing first.");
      return;
    }
    status("📷 Scanning the back of the card…", 30000);

    let dataUrl;
    try {
      dataUrl = await fileToCompressedDataURL(file);
      if (!dataUrl) throw new Error("Couldn't process the image.");
    } catch (err) {
      status(`Image error: ${err.message || "couldn't process photo"}`, 4000);
      return;
    }

    let resp, data;
    try {
      resp = await fetch(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl, mode: "steps_only" })
      });
    } catch {
      status("Couldn't reach the scan server. Check your connection.", 4000);
      return;
    }

    try { data = await resp.json(); }
    catch { status("Scan server returned an unexpected response.", 4000); return; }

    if (!resp.ok || data.error) {
      if (data?.error === "not_a_recipe_card") {
        status("That doesn't look like a recipe-instructions page.", 4000);
      } else {
        status(`Scan failed: ${data?.reason || resp.status}`, 4000);
      }
      return;
    }

    const newSteps = Array.isArray(data.steps) ? data.steps : [];
    if (!newSteps.length) {
      status("No cooking steps found on that photo.", 4000);
      return;
    }

    // Decide: replace, append, or cancel
    let replace = true;
    if (editSteps.length) {
      const choice = confirm(
        `Found ${newSteps.length} cooking step${newSteps.length === 1 ? "" : "s"}.\n\n` +
        `This meal already has ${editSteps.length} step${editSteps.length === 1 ? "" : "s"}.\n\n` +
        `OK = replace existing steps with the scanned ones\n` +
        `Cancel = keep existing, add scanned to the end`
      );
      replace = choice;
    }

    if (replace) {
      editSteps.length = 0;
      newSteps.forEach(s => editSteps.push(s));
    } else {
      newSteps.forEach(s => editSteps.push(s));
    }
    refreshEditSteps();

    // Merge cookMins only if not already set
    if (typeof data.cookMins === "number" && !$("#edit-cook-mins").value.trim()) {
      $("#edit-cook-mins").value = String(data.cookMins);
    }

    // Merge notes only if existing notes are empty
    if (data.notes && !$("#edit-notes").value.trim()) {
      $("#edit-notes").value = data.notes;
    }

    status(`✓ Added ${newSteps.length} step${newSteps.length === 1 ? "" : "s"} from scan`, 3500);
  }
})();
