(function installBalatroModManagerUI() {
  "use strict";

  var ACCEPTED = ".zip,.tar,.tar.gz,.tgz,application/zip,application/x-tar,application/gzip";

  function formatBytes(bytes) {
    if (!bytes) return "0 KB";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    var value = bytes;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return value.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildStyles() {
    var style = document.createElement("style");
    style.textContent = [
      "#modManagerOverlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;",
      "background:rgba(11,30,45,0.72);font-family:Arial,sans-serif;}",
      "#modManagerCard{width:min(560px,92vw);max-height:86vh;display:flex;flex-direction:column;",
      "background:rgb(154,205,237);border:3px solid rgb(11,86,117);border-radius:10px;",
      "box-shadow:0 12px 30px rgba(0,0,0,0.35);overflow:hidden;}",
      "#modManagerCard header{padding:16px 20px;background:rgb(11,86,117);color:#eaf6ff;}",
      "#modManagerCard header h1{margin:0 0 4px;font-size:1.3rem;}",
      "#modManagerCard header p{margin:0;font-size:0.85rem;color:#cfeaff;}",
      "#modManagerBody{padding:16px 20px;overflow-y:auto;flex:1;color:rgb(28,78,104);}",
      "#modDropZone{border:2px dashed rgb(11,86,117);border-radius:8px;padding:18px;text-align:center;",
      "cursor:pointer;background:rgba(255,255,255,0.35);transition:background .15s ease;}",
      "#modDropZone.dragging{background:rgba(255,255,255,0.7);}",
      "#modDropZone strong{display:block;margin-bottom:4px;}",
      "#modDropZone small{color:rgb(28,78,104);opacity:0.8;}",
      "#modManagerBody input[type=file]{display:none;}",
      "#modStatus{margin-top:10px;min-height:1.2em;font-size:0.85rem;}",
      "#modStatus.error{color:#8a1f1f;font-weight:bold;}",
      "#modStatus.busy{color:rgb(11,86,117);font-style:italic;}",
      "#modList{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;}",
      "#modList li{background:rgba(255,255,255,0.55);border-radius:6px;padding:8px 10px;display:flex;",
      "align-items:flex-start;gap:10px;}",
      "#modList .modInfo{flex:1;min-width:0;}",
      "#modList .modName{font-weight:bold;word-break:break-word;}",
      "#modList .modMeta{font-size:0.78rem;opacity:0.85;}",
      "#modList .modWarning{font-size:0.78rem;color:#8a4b1f;margin-top:2px;}",
      "#modList button{border:none;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:0.78rem;",
      "background:#e9499a;color:#fff;}",
      "#modList button:hover{background:#fccfe6;color:#6e1e47;}",
      "#modEmpty{font-size:0.85rem;opacity:0.75;margin-top:10px;}",
      "#modManagerCard footer{padding:14px 20px;background:rgba(11,86,117,0.08);",
      "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}",
      "#modManagerCard footer .hint{font-size:0.75rem;color:rgb(28,78,104);opacity:0.8;}",
      "#modManagerCard footer .actions{display:flex;gap:8px;}",
      "#modManagerCard footer button{border:none;border-radius:6px;padding:9px 16px;font-size:0.9rem;",
      "cursor:pointer;font-weight:bold;}",
      "#launchBtn{background:rgb(11,86,117);color:#fff;}",
      "#launchBtn:hover{background:rgb(15,110,150);}",
      "#safeModeBtn{background:transparent;color:rgb(11,86,117);border:1px solid rgb(11,86,117) !important;}",
      "#safeModeBtn:hover{background:rgba(255,255,255,0.5);}"
    ].join("");
    document.head.appendChild(style);
  }

  function renderMods(listEl, emptyEl, mods, manager, refresh) {
    listEl.innerHTML = "";
    if (!mods.length) {
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";
    mods.forEach(function(mod) {
      var item = el("li");

      var toggle = el("input");
      toggle.type = "checkbox";
      toggle.checked = !!mod.enabled;
      toggle.title = mod.enabled ? "Disable mod" : "Enable mod";
      toggle.addEventListener("change", function() {
        manager.setModEnabled(mod.id, toggle.checked).then(refresh);
      });

      var info = el("div", "modInfo");
      var name = el("div", "modName", mod.name || mod.id);
      var meta = el(
        "div",
        "modMeta",
        (mod.version ? "v" + mod.version + " \u2022 " : "") +
          formatBytes(mod.size) +
          " \u2022 " +
          (mod.fileCount || 0) +
          " files \u2022 " +
          (mod.compatibilityStatus || "compatible")
      );
      info.appendChild(name);
      info.appendChild(meta);
      if (mod.warnings && mod.warnings.length) {
        var warn = el("div", "modWarning", "\u26a0 " + mod.warnings[0] + (mod.warnings.length > 1 ? " (+" + (mod.warnings.length - 1) + " more)" : ""));
        info.appendChild(warn);
      }

      var remove = el("button", null, "Remove");
      remove.addEventListener("click", function() {
        remove.disabled = true;
        manager.deleteMod(mod.id).then(refresh);
      });

      item.appendChild(toggle);
      item.appendChild(info);
      item.appendChild(remove);
      listEl.appendChild(item);
    });
  }

  function setStatus(statusEl, text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = kind || "";
  }

  function init(onLaunch) {
    if (!window.BalatroModManager || typeof window.BalatroModManager.installArchive !== "function") {
      // Runtime not available for some reason; skip straight to launch.
      onLaunch(false);
      return;
    }
    var manager = window.BalatroModManager;

    buildStyles();

    var overlay = el("div");
    overlay.id = "modManagerOverlay";
    var card = el("div");
    card.id = "modManagerCard";

    var header = el("header");
    header.appendChild(el("h1", null, "Mod Manager"));
    header.appendChild(el("p", null, "Add Steamodded/SMODS mods before launching. Files stay in your browser."));
    card.appendChild(header);

    var body = el("div");
    body.id = "modManagerBody";

    var dropZone = el("div");
    dropZone.id = "modDropZone";
    dropZone.appendChild(el("strong", null, "Click to choose a mod archive"));
    dropZone.appendChild(el("small", null, "or drag & drop a .zip, .tar, or .tar.gz here (100 MB max)"));
    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = ACCEPTED;
    fileInput.multiple = true;
    dropZone.appendChild(fileInput);
    body.appendChild(dropZone);

    var statusEl = el("div");
    statusEl.id = "modStatus";
    body.appendChild(statusEl);

    var emptyEl = el("div", null, "No mods installed yet.");
    emptyEl.id = "modEmpty";
    body.appendChild(emptyEl);

    var listEl = el("ul");
    listEl.id = "modList";
    body.appendChild(listEl);

    card.appendChild(body);

    var footer = el("div");
    var hint = el("div", "hint", "Mods persist in this browser for next time.");
    var actions = el("div", "actions");
    var safeModeBtn = el("button", null, "Launch without mods");
    safeModeBtn.id = "safeModeBtn";
    var launchBtn = el("button", null, "Launch Game");
    launchBtn.id = "launchBtn";
    actions.appendChild(safeModeBtn);
    actions.appendChild(launchBtn);
    footer.appendChild(hint);
    footer.appendChild(actions);
    card.appendChild(footer);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function refresh() {
      manager
        .getMods()
        .then(function(mods) {
          mods.sort(function(a, b) {
            return (a.name || a.id).localeCompare(b.name || b.id);
          });
          renderMods(listEl, emptyEl, mods, manager, refresh);
        })
        .catch(function(error) {
          setStatus(statusEl, "Could not read stored mods: " + error, "error");
        });
    }

    function handleFiles(files) {
      var list = Array.prototype.slice.call(files || []);
      if (!list.length) return;
      setStatus(statusEl, "Installing " + list.length + " archive" + (list.length > 1 ? "s" : "") + "\u2026", "busy");
      launchBtn.disabled = true;

      var chain = Promise.resolve();
      list.forEach(function(file) {
        chain = chain.then(function() {
          return file.arrayBuffer().then(function(bytes) {
            return manager.installArchive({
              name: file.name,
              type: file.type,
              bytes: bytes
            });
          });
        });
      });

      chain
        .then(function() {
          setStatus(statusEl, "Done.", "");
          refresh();
        })
        .catch(function(error) {
          setStatus(statusEl, "Install failed: " + (error && error.message ? error.message : error), "error");
        })
        .finally(function() {
          launchBtn.disabled = false;
          fileInput.value = "";
        });
    }

    dropZone.addEventListener("click", function() {
      fileInput.click();
    });
    fileInput.addEventListener("change", function() {
      handleFiles(fileInput.files);
    });
    ["dragenter", "dragover"].forEach(function(type) {
      dropZone.addEventListener(type, function(event) {
        event.preventDefault();
        dropZone.classList.add("dragging");
      });
    });
    ["dragleave", "drop"].forEach(function(type) {
      dropZone.addEventListener(type, function(event) {
        event.preventDefault();
        dropZone.classList.remove("dragging");
      });
    });
    dropZone.addEventListener("drop", function(event) {
      handleFiles(event.dataTransfer && event.dataTransfer.files);
    });

    function close(safeMode) {
      overlay.remove();
      onLaunch(safeMode);
    }

    launchBtn.addEventListener("click", function() {
      close(false);
    });
    safeModeBtn.addEventListener("click", function() {
      try {
        sessionStorage.setItem("balatro-web-safe-mode", "1");
      } catch (error) {}
      close(true);
    });

    refresh();
  }

  window.BalatroModManagerUI = { open: init };
})();
