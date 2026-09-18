(function () {
  var home = document.getElementById("home");
  var project = document.getElementById("project");
  var cards = document.getElementById("cards");
  var empty = document.getElementById("empty");
  var projTitle = document.getElementById("proj-title");
  var noteText = document.getElementById("note-text");
  var notePage = document.getElementById("note-page");
  var pagerLabel = document.getElementById("pager-label");
  var playNotes = document.getElementById("play-notes");
  var playTimer = document.getElementById("play-timer");
  var frameMain = document.getElementById("frame-main");
  var frameNext = document.getElementById("frame-next");
  var workspace = document.getElementById("workspace");
  var cardTip = document.getElementById("card-tip");
  var cardTipTimer = 0;

  var sidebarResizers = Array.from(document.querySelectorAll(".sidebar-resizer"));
  var sidebarWidth = 0;
  var sidebarDrag = null;
  var sidebarFrame = 0;
  var pendingSidebarWidth = 0;
  try {
    var savedWidth = Number(localStorage.getItem("slide-sidebar-width"));
    if (Number.isFinite(savedWidth) && savedWidth > 0) sidebarWidth = savedWidth;
  } catch (_) {}

  function sidebarLimits() {
    return { min: 260, max: Math.max(260, Math.min(600, workspace.clientWidth - 360)) };
  }

  function applySidebarWidth(width) {
    if (!workspace.clientWidth) return;
    var limits = sidebarLimits();
    var actual = Math.round(Math.max(limits.min, Math.min(limits.max, width)));
    workspace.style.setProperty("--sidebar-width", actual + "px");
    sidebarResizers.forEach(function (handle) {
      handle.setAttribute("aria-valuemin", limits.min);
      handle.setAttribute("aria-valuemax", limits.max);
      handle.setAttribute("aria-valuenow", actual);
      handle.setAttribute("aria-valuetext", actual + " 像素");
    });
    return actual;
  }

  function rememberSidebarWidth() {
    try { localStorage.setItem("slide-sidebar-width", sidebarWidth); } catch (_) {}
  }

  function finishSidebarDrag() {
    if (!sidebarDrag) return;
    if (sidebarFrame) {
      cancelAnimationFrame(sidebarFrame);
      sidebarFrame = 0;
      sidebarWidth = applySidebarWidth(pendingSidebarWidth);
    }
    var pointerId = sidebarDrag.pointerId;
    var handle = sidebarDrag.handle;
    sidebarDrag = null;
    document.body.classList.remove("resizing-sidebar");
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    rememberSidebarWidth();
  }

  sidebarResizers.forEach(function (sidebarResizer) {
    sidebarResizer.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || sidebarDrag) return;
    event.preventDefault();
    sidebarDrag = {
      pointerId: event.pointerId,
      handle: sidebarResizer,
      x: event.clientX,
      width: sidebarResizer.parentElement.getBoundingClientRect().width
    };
    sidebarResizer.setPointerCapture(event.pointerId);
    sidebarResizer.focus({ preventScroll: true });
    document.body.classList.add("resizing-sidebar");
    });
  });
  window.addEventListener("pointermove", function (event) {
    if (!sidebarDrag || event.pointerId !== sidebarDrag.pointerId) return;
    pendingSidebarWidth = sidebarDrag.width + sidebarDrag.x - event.clientX;
    if (!sidebarFrame) sidebarFrame = requestAnimationFrame(function () {
      sidebarFrame = 0;
      sidebarWidth = applySidebarWidth(pendingSidebarWidth);
    });
  });
  ["pointerup", "pointercancel"].forEach(function (name) {
    window.addEventListener(name, finishSidebarDrag);
  });
  window.addEventListener("blur", finishSidebarDrag);
  sidebarResizers.forEach(function (sidebarResizer) {
    sidebarResizer.addEventListener("lostpointercapture", finishSidebarDrag);
    sidebarResizer.addEventListener("keydown", function (event) {
    var limits = sidebarLimits();
    var width = sidebarResizer.parentElement.getBoundingClientRect().width;
    if (event.key === "ArrowLeft") width += 16;
    else if (event.key === "ArrowRight") width -= 16;
    else if (event.key === "Home") width = limits.min;
    else if (event.key === "End") width = limits.max;
    else return;
    event.preventDefault();
    event.stopPropagation();
    sidebarWidth = applySidebarWidth(width);
    rememberSidebarWidth();
    });
  });
  new ResizeObserver(function () {
    applySidebarWidth(sidebarWidth || (window.innerWidth <= 1050 ? 270 : 310));
  }).observe(workspace);

  // Keep both documents at the same design resolution. Resizing only changes
  // the outer transform, so text, video and layout scale together without reflow.
  var canvasWidth = 1920;
  var canvasHeight = 1080;
  var stage = document.querySelector(".stage");
  var viewport = document.querySelector(".viewport");
  var nextBox = document.querySelector(".next-box");
  var playSidebar = document.getElementById("col-play");
  function fitCanvas(box, availableWidth, availableHeight) {
    if (availableWidth <= 0 || availableHeight <= 0) return;
    var scale = Math.min(availableWidth / canvasWidth, availableHeight / canvasHeight);
    box.style.width = canvasWidth * scale + "px";
    box.style.height = canvasHeight * scale + "px";
    box.style.setProperty("--canvas-scale", scale);
  }
  function fitPreviews() {
    fitCanvas(viewport, stage.clientWidth, stage.clientHeight);
    if (playSidebar.clientWidth) {
      var style = getComputedStyle(playSidebar);
      var width = playSidebar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      fitCanvas(nextBox, width, playSidebar.clientHeight * 0.3);
    }
  }
  var canvasObserver = new ResizeObserver(fitPreviews);
  canvasObserver.observe(stage);
  canvasObserver.observe(playSidebar);

  var current = null;
  var urls = null;
  var pages = {};
  var idx = 0;
  var count = 0;
  var mode = "edit";
  var saveTimer = 0;
  var notesDirty = false;
  var polling = false;
  var tick0 = 0;
  var ticking = false;
  var bound = false;
  var noteFs = 16;
  var library = [];
  var toastTimer;
  var importing = false;
  var casting = false;
  var playRequest = 0;
  function toast(message) {
    var el = document.getElementById("toast");
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("hidden"); }, 4500);
  }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    var dark = theme === "dark";
    document.getElementById("theme-label").textContent = dark ? "纯黑" : "纯白";
    var button = document.getElementById("btn-theme");
    button.title = dark ? "切换为纯白模式" : "切换为纯黑模式";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(dark));
    try { localStorage.setItem("slide-theme", theme); } catch (_) {}
  }
  applyTheme(document.documentElement.dataset.theme);
  document.getElementById("btn-theme").onclick = function () { applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); };
  ["minimize", "maximize", "close"].forEach(function (action) {
    document.getElementById("btn-" + action).onclick = async function () {
      if (action === "close") { clearTimeout(saveTimer); await persistNotes(); }
      api.windowControl(action);
    };
  });
  function windowState(state) {
    var button = document.getElementById("btn-maximize");
    button.title = state.maximized ? "向下还原" : "最大化";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = state.maximized ? '<svg viewBox="0 0 16 16"><path d="M6 3h7v7M3 6h7v7H3z"/></svg>' : '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9"/></svg>';
  }
  api.windowState().then(windowState);
  api.onWindowState(windowState);
  function castState(active) {
    casting = active;
    document.getElementById("btn-stop").disabled = !active;
    document.getElementById("cast-status").textContent = active ? "正在投屏" : "未投屏";
    document.getElementById("project-status").textContent = active ? "正在向扩展屏播放" : "准备就绪";
    if (!active) ticking = false;
  }
  function stopPlayback() { playRequest++; api.stop(); castState(false); if (mode === "play") setMode("edit"); }
  async function importProject() {
    if (importing) return;
    importing = true;
    document.getElementById("btn-import").disabled = true;
    try {
      await persistNotes();
      var p = await api.importHtml();
      if (p) { document.getElementById("search").value = ""; loadLibrary(); await openProject(p.id); }
    } catch (_) { toast("导入失败，请检查 HTML 文件后重试。"); }
    finally { importing = false; document.getElementById("btn-import").disabled = false; }
  }
  api.onImport(importProject);
  api.onPlayRequest(function (action) { if (action === "stop") stopPlayback(); else if (current) setMode("play"); else toast("请先打开一份演示。"); });
  document.getElementById("btn-empty-import").onclick = importProject;
  document.getElementById("search").addEventListener("input", function () { renderCards(library); });
  window.addEventListener("keydown", function (e) { if (e.key === "/" && !current && !/INPUT|TEXTAREA/.test(e.target.tagName)) { e.preventDefault(); document.getElementById("search").focus(); } });

  function bust(url) {
    if (!url) return "";
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "t=" + Date.now();
  }

  function maxIdx() {
    return Math.max(0, (count || 1) - 1);
  }

  function showHome() {
    finishSidebarDrag();
    home.classList.remove("hidden");
    project.classList.add("hidden");
    clearTimeout(saveTimer);
    playRequest++;
    castState(false);
    frameMain.src = "about:blank";
    frameNext.src = "about:blank";
    current = null;
    urls = null;
    bound = false;
    api.stop();
  }

  function showProject() {
    home.classList.add("hidden");
    project.classList.remove("hidden");
  }

  function setMode(next) {
    finishSidebarDrag();
    if (next === "preview") next = "edit";
    mode = next;
    var request = ++playRequest;
    document.querySelectorAll(".btn-tab").forEach(function (b) {
      var selected = b.getAttribute("data-mode") === next;
      b.classList.toggle("is-on", selected);
      b.setAttribute("aria-pressed", String(selected));
    });
    workspace.classList.remove("mode-edit", "mode-preview", "mode-play");
    workspace.classList.add("mode-" + next);
    document.getElementById("stage-mode").textContent = {edit: "讲稿编辑", play: "投屏播放"}[next];
    syncNextPreview();
    if (next === "play") {
      api.play().then(function (r) {
        if (request !== playRequest) return;
        if (!r || !r.ok) { castState(false); setMode("edit"); toast((r && r.error) || "无法开始投屏"); return; }
        if (!ticking) { tick0 = Date.now(); playTimer.textContent = "00:00:00"; }
        ticking = true;
        castState(true);
      }).catch(function () { if (request === playRequest) { castState(false); setMode("edit"); toast("投屏连接失败，请重试。"); } });
    }
  }

  function formatImportTime(ms) {
    if (!ms) return "未知";
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  }

  function hideCardTip() {
    clearTimeout(cardTipTimer);
    cardTip.classList.add("hidden");
  }

  function placeCardTip(card) {
    var r = card.getBoundingClientRect();
    var tw = cardTip.offsetWidth;
    var th = cardTip.offsetHeight;
    var left = Math.min(Math.max(12, r.left), window.innerWidth - tw - 12);
    var top = r.bottom + 8;
    if (top + th > window.innerHeight - 12) top = r.top - th - 8;
    if (top < 12) top = 12;
    cardTip.style.left = left + "px";
    cardTip.style.top = top + "px";
  }

  function showCardTip(card, p) {
    var html = "";
    if (p.missing) html += '<div class="card-tip-miss">文件丢失</div>';
    html +=
      '<div class="card-tip-row"><span>路径</span><span>' +
      esc(p.htmlPath || "") +
      '</span></div><div class="card-tip-row"><span>导入</span><span>' +
      esc(formatImportTime(p.createdAt)) +
      "</span></div>";
    cardTip.innerHTML = html;
    cardTip.classList.remove("hidden");
    placeCardTip(card);
  }

  function renderCards(list) {
    hideCardTip();
    library = list;
    var query = document.getElementById("search").value.trim().toLowerCase();
    var visible = list.filter(function (p) { return ((p.title || "") + " " + fileName(p.htmlPath)).toLowerCase().includes(query); });
    cards.innerHTML = "";
    document.getElementById("library-count").textContent = list.length;
    empty.style.display = visible.length ? "none" : "block";
    document.getElementById("empty-title").textContent = query ? "没有找到匹配的演示" : "你的下一场精彩，从这里开始";
    document.getElementById("empty-description").textContent = query ? "试试其他标题或文件名。" : "导入一份 HTML，即可预览、记录讲稿和投屏演示。";
    document.getElementById("btn-empty-import").classList.toggle("hidden", !!query);
    visible.forEach(function (p) {
      var card = document.createElement("article");
      card.className = "card";
      var open = document.createElement("button");
      open.className = "card-open";
      open.type = "button";
      open.setAttribute("aria-label", "打开 " + (p.title || "未命名"));
      var thumb = p.cover ? '<img alt="" loading="lazy" decoding="async" src="' + esc(p.cover) + '" />' : '<div class="thumb-placeholder">HTML</div>';
      open.innerHTML = '<div class="thumb">' + thumb + '<span class="thumb-badge">HTML</span></div><div class="card-body"><h2>' + esc(p.title || "未命名") + '</h2><div class="card-meta"><span>' + (p.slideCount || 0) + ' 页幻灯片</span><span class="' + (p.missing ? 'miss' : '') + '">' + (p.missing ? '文件丢失' : esc(fileName(p.htmlPath))) + '</span></div></div>';
      open.addEventListener("click", function () { openProject(p.id); });
      card.appendChild(open);
      var bottom = document.createElement("div");
      bottom.className = "card-bottom";
      var date = document.createElement("span");
      date.textContent = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString("zh-CN") + " 更新" : "本地演示";
      bottom.appendChild(date);
      var del = document.createElement("button");
      del.type = "button";
      del.className = "card-del";
      del.textContent = "移除";
      del.setAttribute("aria-label", "从项目库移除 " + (p.title || "未命名"));
      del.addEventListener("click", function () {
        if (!confirm("只从容器项目库移除，不删除 HTML 文件。")) return;
        api.remove(p.id).then(renderCards);
      });
      bottom.appendChild(del);
      card.appendChild(bottom);
      card.addEventListener("mouseenter", function () {
        clearTimeout(cardTipTimer);
        cardTipTimer = setTimeout(function () {
          showCardTip(card, p);
        }, 160);
      });
      card.addEventListener("mouseleave", hideCardTip);
      cards.appendChild(card);
    });
  }

  function fileName(p) {
    if (!p) return "";
    return String(p).split(/[/\\]/).pop();
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function loadLibrary() {
    return api.list().then(renderCards).catch(function () { toast("项目库加载失败，请重试。"); });
  }

  function syncNextPreview() {
    if (mode === "play" && urls) {
      if (frameNext.dataset.deckUrl !== urls.nextUrl) {
        frameNext.dataset.deckUrl = urls.nextUrl;
        frameNext.src = bust(urls.nextUrl);
      }
    } else {
      delete frameNext.dataset.deckUrl;
      if (frameNext.getAttribute("src") !== "about:blank") frameNext.src = "about:blank";
    }
  }

  function bindFrames(nextUrls) {
    urls = nextUrls;
    frameMain.src = bust(nextUrls.url);
    delete frameNext.dataset.deckUrl;
    syncNextPreview();
    bound = true;
  }

  function openProject(id) {
    return api.openProject(id).then(function (r) {
      if (!r || !r.ok) {
        toast((r && r.error) || "无法打开");
        return;
      }
      current = r.project;
      idx = r.idx || 0;
      count = r.count || current.slideCount || 0;
      projTitle.textContent = current.title || "项目";
      return api.notesGet(current.id).then(function (n) {
        pages = (n && n.pages) || {};
        notesDirty = false;
        showProject();
        setMode("edit");
        bindFrames(r);
        paintNotes();
      });
    });
  }

  function applyNoteFs() {
    playNotes.style.fontSize = noteFs + "px";
  }

  function bumpNoteFs(delta) {
    noteFs = Math.max(12, Math.min(64, noteFs + delta));
    applyNoteFs();
  }

  function paintNotes() {
    var key = String(idx);
    var total = Math.max(count, 1);
    noteText.value = pages[key] || "";
    notePage.textContent = idx + 1 + " / " + total;
    pagerLabel.textContent = idx + 1 + " / " + total;
    playNotes.textContent = pages[key] || "（本页还没有备注）";
    document.getElementById("btn-prev").disabled = idx <= 0;
    document.getElementById("btn-next").disabled = idx >= maxIdx();
  }

  function persistNotes() {
    if (!current || !notesDirty) return;
    pages[String(idx)] = noteText.value;
    notesDirty = false;
    var savedId = current.id;
    clearTimeout(saveTimer);
    var status = document.getElementById("save-status");
    status.textContent = "正在保存…";
    return api.notesSave(current.id, pages).then(function () { status.textContent = "已自动保存"; }).catch(function () { if (current && current.id === savedId) notesDirty = true; status.textContent = "保存失败"; toast("备注保存失败，请重试。"); });
  }

  function go(i) {
    if (!current) return;
    persistNotes();
    idx = Math.max(0, Math.min(maxIdx(), i));
    api.go(idx).then(function (d) {
      if (d && typeof d.count === "number" && d.count) count = d.count;
      paintNotes();
    });
  }

  function poll() {
    if (!current || polling) return;
    polling = true;
    var polledId = current.id;
    api.sync().then(function (d) {
      if (!d || !current || current.id !== polledId) return;
      if (typeof d.cast === "boolean" && casting !== d.cast) castState(d.cast);
      if (typeof d.count === "number" && d.count && d.count !== count) {
        count = d.count;
        paintNotes();
      }
      if (typeof d.idx === "number" && d.idx !== idx) {
        persistNotes();
        idx = d.idx;
        paintNotes();
      }
    }).catch(function () {}).finally(function () { polling = false; });
  }

  function tick() {
    if (!ticking) return;
    var sec = Math.floor((Date.now() - tick0) / 1000);
    var h = String(Math.floor(sec / 3600)).padStart(2, "0");
    var m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    var s = String(sec % 60).padStart(2, "0");
    playTimer.textContent = h + ":" + m + ":" + s;
  }

  document.getElementById("btn-import").addEventListener("click", importProject);
  document.getElementById("btn-back").addEventListener("click", async function () {
    await persistNotes();
    showHome();
    loadLibrary();
  });
  document.getElementById("btn-stop").addEventListener("click", stopPlayback);
  document.getElementById("btn-prev").addEventListener("click", function () {
    go(idx - 1);
  });
  document.getElementById("btn-next").addEventListener("click", function () {
    go(idx + 1);
  });
  document.querySelectorAll(".btn-tab").forEach(function (b) {
    b.addEventListener("click", function () {
      persistNotes();
      setMode(b.getAttribute("data-mode"));
    });
  });
  document.getElementById("btn-note-smaller").addEventListener("click", function () {
    bumpNoteFs(-2);
  });
  document.getElementById("btn-note-bigger").addEventListener("click", function () {
    bumpNoteFs(2);
  });
  playNotes.addEventListener(
    "wheel",
    function (e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      bumpNoteFs(e.deltaY < 0 ? 2 : -2);
    },
    { passive: false }
  );
  applyNoteFs();

  noteText.addEventListener("input", function () {
    notesDirty = true;
    pages[String(idx)] = noteText.value;
    playNotes.textContent = noteText.value || "（本页还没有备注）";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNotes, 400);
  });

  window.addEventListener(
    "keydown",
    function (e) {
      if (!current || project.classList.contains("hidden")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable || sidebarResizers.includes(e.target)) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(idx - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        go(idx + 1);
      }
    },
    true
  );

  api.onReload(function () {
    if (!current || !urls) return;
    api.openProject(current.id).then(function (r) {
      if (r && r.ok) bindFrames(r);
    });
  });

  var libraryScroll = document.querySelector(".library-scroll");
  if (libraryScroll) libraryScroll.addEventListener("scroll", hideCardTip, { passive: true });
  window.addEventListener("blur", hideCardTip);

  setInterval(poll, 200);
  setInterval(tick, 250);
  // Let the shell paint before requesting and laying out the project library.
  requestAnimationFrame(function () { requestAnimationFrame(loadLibrary); });
})();
