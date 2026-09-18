const { app, BrowserWindow, dialog, screen, Menu, ipcMain, session } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const store = require("./store");

app.setAppUserModelId("com.cuedesk.presenter");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let shellWin = null;
let audienceWin = null;
let coverWin = null;
let server = null;
let deckDir = "";
let deckFile = "";
let currentId = "";
let port = 0;
let slideIdx = 0;
let slideCount = 0;
let mediaState = { playing: false, t: 0, slide: 0, mi: 0, fullscreen: false };
let watcher = null;

const INJECT = fs.readFileSync(path.join(__dirname, "inject.js"), "utf8");

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".mp4": "video/mp4",
      ".json": "application/json",
      ".woff2": "font/woff2",
    }[ext] || "application/octet-stream"
  );
}

function send(res, code, type, body) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function inspectHtml(filePath) {
  let html = "";
  try {
    html = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return { title: path.basename(filePath), slideCount: 0 };
  }
  const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const slides = html.match(/class=["'][^"']*\bslide\b[^"']*["']/gi);
  return {
    title: (t && t[1].trim()) || path.basename(filePath, path.extname(filePath)),
    slideCount: slides ? slides.length : 0,
  };
}

function prepareDeckHtml(html) {
  // Optional online fonts must never delay the first local slide render.
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag) || /\b(?:media|onload)\s*=/i.test(tag)) return tag;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) return tag;
    try {
      if (new URL(href[1]).hostname !== "fonts.googleapis.com") return tag;
    } catch (_) { return tag; }
    return tag.replace(/\s*\/?>(?=$)/, ' media="print" onload="this.media=\'all\'">');
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/__sync") {
        const i = u.searchParams.get("i");
        if (i != null && i !== "") setSlideIdx(i);
        send(res, 200, "application/json", JSON.stringify({
          idx: slideIdx,
          count: slideCount,
          cast: !!(audienceWin && !audienceWin.isDestroyed()),
        }));
        return;
      }
      if (u.pathname === "/__media") {
        if (req.method === "POST") {
          readBody(req).then((raw) => {
            try {
              const d = JSON.parse(raw || "{}");
              mediaState = {
                playing: !!d.playing,
                t: typeof d.t === "number" ? d.t : mediaState.t,
                slide: Number.isFinite(d.slide) ? d.slide : mediaState.slide,
                mi: Number.isFinite(d.mi) ? d.mi : mediaState.mi,
                fullscreen: d.fullscreen === undefined ? mediaState.fullscreen : !!d.fullscreen,
              };
              pushMedia();
            } catch (_) {}
            send(res, 200, "application/json", JSON.stringify(mediaState));
          });
          return;
        }
        send(res, 200, "application/json", JSON.stringify(mediaState));
        return;
      }
      if (u.pathname === "/__meta" && req.method === "POST") {
        readBody(req).then((raw) => {
          try {
            const d = JSON.parse(raw || "{}");
            if (typeof d.count === "number" && d.count > 0) {
              slideCount = d.count;
              if (currentId && store.get(currentId)?.slideCount !== slideCount) store.update(currentId, { slideCount });
            }
            if (d.title && currentId) {
              const proj = store.get(currentId);
              if (proj && (!proj.title || proj.title === path.basename(proj.htmlPath, path.extname(proj.htmlPath)))) {
                store.update(currentId, { title: String(d.title).replace(/\s*-\s*投屏.*$/, "").trim() });
              }
            }
          } catch (_) {}
          send(res, 200, "text/plain", "ok");
        });
        return;
      }
      if (u.pathname === "/__cast") {
        startAudience();
        send(res, 200, "text/plain", "ok");
        return;
      }
      if (u.pathname === "/__end") {
        closeAudience();
        send(res, 200, "text/plain", "ok");
        return;
      }
      if (u.pathname === "/__inject.js") {
        send(res, 200, "application/javascript; charset=utf-8", INJECT);
        return;
      }
      if (!deckDir) {
        send(res, 404, "text/plain", "no deck");
        return;
      }
      let rel = decodeURIComponent(u.pathname);
      if (rel === "/") rel = "/" + deckFile;
      const root = path.normalize(deckDir + path.sep);
      const file = path.normalize(path.join(deckDir, rel.replace(/^\//, "")));
      if (!file.startsWith(root) && file !== path.normalize(deckDir)) {
        send(res, 403, "text/plain", "forbidden");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      if (ext === ".html" || ext === ".htm") {
        fs.readFile(file, (err, data) => {
          if (err) {
            send(res, 404, "text/plain", "not found");
            return;
          }
          const marker = "/__inject.js";
          if (!data.includes(Buffer.from(marker))) {
            const html = prepareDeckHtml(data.toString("utf8"));
            const snippet = '<script src="/__inject.js"></script>';
            const lower = html.toLowerCase();
            const at = lower.lastIndexOf("</body>");
            const out = at >= 0 ? html.slice(0, at) + snippet + html.slice(at) : html + snippet;
            send(res, 200, contentType(file), Buffer.from(out));
            return;
          }
          send(res, 200, contentType(file), data);
        });
        return;
      }
      streamFile(req, res, file);
    });
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve(port);
    });
    server.on("error", reject);
  });
}

function streamFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, "text/plain", "not found");
      return;
    }
    const total = st.size;
    const type = contentType(file);
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        res.writeHead(416, { "Content-Range": "bytes */" + total });
        res.end();
        return;
      }
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.writeHead(416, { "Content-Range": "bytes */" + total });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
}

function deckUrl(query) {
  const q = query ? "?" + query : "";
  return "http://127.0.0.1:" + port + "/" + encodeURIComponent(deckFile) + q;
}

function watchDeck() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (!deckDir) return;
  try {
    watcher = fs.watch(deckDir, { recursive: true }, (event, filename) => {
      const name = String(filename || "");
      if (name.split(/[/\\]/).some((part) => part.startsWith(".") || part === "node_modules")) return;
      if (!/\.(html?|css|js|png|jpe?g|gif|webp|svg|mp4)$/i.test(name)) return;
      clearTimeout(watchDeck._t);
      watchDeck._t = setTimeout(() => {
        if (audienceWin && !audienceWin.isDestroyed()) audienceWin.reload();
        if (shellWin && !shellWin.isDestroyed()) shellWin.webContents.send("deck:reload");
      }, 600);
    });
  } catch (_) {}
}

function displayOf(win) {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(win.getBounds());
}

function pickProjector() {
  const all = screen.getAllDisplays();
  if (all.length < 2) return null;
  const laptop = displayOf(shellWin);
  const externals = all.filter((d) => d.internal === false);
  if (externals.length) {
    return externals.find((d) => d.id !== laptop.id) || externals[0];
  }
  return all.find((d) => d.id !== laptop.id) || null;
}

let audiencePinTimer = 0;

function audienceOnProjector(win, proj) {
  if (!win || win.isDestroyed() || !proj) return false;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  if (d.id !== proj.id) return false;
  return (
    Math.abs(b.x - proj.bounds.x) <= 16 &&
    Math.abs(b.y - proj.bounds.y) <= 16 &&
    (win.isFullScreen() || (Math.abs(b.width - proj.bounds.width) <= 16 && Math.abs(b.height - proj.bounds.height) <= 16))
  );
}

function placeAudienceOnProjector(win, proj) {
  if (!win || win.isDestroyed() || !proj) return;
  if (audienceOnProjector(win, proj)) return;
  const apply = function () {
    if (win.isDestroyed()) return;
    const latest = pickProjector() || proj;
    if (audienceOnProjector(win, latest)) return;
    const b = latest.bounds;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
    win.setFullScreen(true);
    if (shellWin && !shellWin.isDestroyed()) shellWin.focus();
  };
  if (win.isFullScreen()) {
    win.once("leave-full-screen", function () {
      setTimeout(apply, 40);
    });
    win.setFullScreen(false);
    return;
  }
  apply();
}

function bindDisplayWatch() {
  const relocate = function () {
    clearTimeout(audiencePinTimer);
    audiencePinTimer = setTimeout(function () {
      if (!audienceWin || audienceWin.isDestroyed()) return;
      const proj = pickProjector();
      if (!proj) {
        closeAudience();
        return;
      }
      placeAudienceOnProjector(audienceWin, proj);
    }, 120);
  };
  screen.on("display-added", relocate);
  screen.on("display-removed", relocate);
  screen.on("display-metrics-changed", relocate);
}

function muteLaptop(on) {
  if (shellWin && !shellWin.isDestroyed()) {
    shellWin.webContents.setAudioMuted(!!on);
  }
}

function closeAudience() {
  if (audienceWin && !audienceWin.isDestroyed()) audienceWin.close();
  audienceWin = null;
  muteLaptop(false);
}

function routeAudienceAudio() {
  if (!audienceWin || audienceWin.isDestroyed()) return;
  const js = `(async function(){
    try {
      var devs = await navigator.mediaDevices.enumerateDevices();
      var outs = devs.filter(function(d){ return d.kind === 'audiooutput'; });
      var re = /hdmi|display|projector|nvidia|amd|digital|显示器|电视|monitor|high definition audio|realtek digital/i;
      var pick = null;
      var i;
      for (i = 0; i < outs.length; i++) {
        if (re.test(outs[i].label || '')) { pick = outs[i]; break; }
      }
      if (!pick) {
        for (i = 0; i < outs.length; i++) {
          if (outs[i].deviceId && outs[i].deviceId !== 'default' && outs[i].deviceId !== 'communications') {
            pick = outs[i];
            break;
          }
        }
      }
      var vs = document.querySelectorAll('video,audio');
      for (i = 0; i < vs.length; i++) {
        vs[i].muted = false;
        vs[i].volume = 1;
        if (pick && vs[i].setSinkId) {
          try { await vs[i].setSinkId(pick.deviceId); } catch (e) {}
        }
      }
    } catch (e) {}
  })()`;
  audienceWin.webContents.executeJavaScript(js).catch(function () {});
}

function setSlideIdx(i) {
  const n = parseInt(i, 10);
  if (!Number.isFinite(n)) return slideIdx;
  const next = Math.max(0, n);
  const changed = next !== slideIdx;
  slideIdx = next;
  if (changed) {
    mediaState = { playing: false, t: 0, slide: next, mi: 0, fullscreen: false };
    pushAllViews();
    pushMedia();
  }
  return slideIdx;
}

function runInFrames(contents, js) {
  if (!contents || contents.isDestroyed()) return;
  function walk(frame) {
    if (!frame) return;
    try {
      frame.executeJavaScript(js).catch(function () {});
    } catch (_) {}
    const kids = frame.frames || [];
    for (let i = 0; i < kids.length; i++) walk(kids[i]);
  }
  try {
    walk(contents.mainFrame);
  } catch (_) {}
}

function pushAllViews() {
  const n = slideIdx;
  const js = "window.__deckGo && window.__deckGo(" + n + ")";
  if (audienceWin && !audienceWin.isDestroyed()) {
    audienceWin.webContents.executeJavaScript(js).catch(function () {});
  }
  if (shellWin && !shellWin.isDestroyed()) {
    runInFrames(shellWin.webContents, js);
    if (!shellWin.isFocused()) shellWin.focus();
  }
}

function pushMedia() {
  if (!audienceWin || audienceWin.isDestroyed()) return;
  const cmd = JSON.stringify(mediaState);
  const js =
    "(function(c){var slides=document.querySelectorAll('#deck-stage > .slide');if(!slides.length)slides=document.querySelectorAll('.slide');var v=slides[c.slide]&&slides[c.slide].querySelectorAll('video,audio')[c.mi];if(!v)v=document.querySelector('video[data-cast-fs]')||document.querySelector('video');if(!v)return;v.muted=false;v.volume=1;if(typeof c.t==='number'&&Math.abs((v.currentTime||0)-c.t)>0.5){try{v.currentTime=c.t;}catch(e){}}if(c.playing){var p=v.play();if(p&&p.catch)p.catch(function(){});}else{v.pause();}if(c.fullscreen){if(!v.__fsHome&&v.parentNode)v.__fsHome={parent:v.parentNode,next:v.nextSibling};document.documentElement.appendChild(v);v.setAttribute('data-cast-fs','1');v.style.setProperty('position','fixed','important');v.style.setProperty('left','0','important');v.style.setProperty('top','0','important');v.style.setProperty('width','100vw','important');v.style.setProperty('height','100vh','important');v.style.setProperty('max-width','none','important');v.style.setProperty('max-height','none','important');v.style.setProperty('z-index','2147483647','important');v.style.setProperty('object-fit','contain','important');v.style.setProperty('background','#000','important');v.style.setProperty('transform','none','important');v.style.setProperty('margin','0','important');}else{v.removeAttribute('data-cast-fs');v.style.cssText='';var h=v.__fsHome;if(h&&h.parent){if(h.next&&h.next.parentNode===h.parent)h.parent.insertBefore(v,h.next);else h.parent.appendChild(v);}}})(" +
    cmd +
    ")";
  audienceWin.webContents.executeJavaScript(js).catch(function () {});
  routeAudienceAudio();
}

function startAudience() {
  if (!deckFile) return { ok: false, error: "请先打开项目" };
  const proj = pickProjector();
  if (!proj) {
    return { ok: false, error: "没检测到扩展屏。请 Win+P 选扩展后再播放。" };
  }
  if (audienceWin && !audienceWin.isDestroyed()) {
    muteLaptop(true);
    audienceWin.webContents.setAudioMuted(false);
    placeAudienceOnProjector(audienceWin, proj);
    pushAllViews();
    pushMedia();
    routeAudienceAudio();
    return { ok: true };
  }
  audienceWin = new BrowserWindow({
    x: proj.bounds.x,
    y: proj.bounds.y,
    width: proj.bounds.width,
    height: proj.bounds.height,
    show: false,
    fullscreen: false,
    frame: false,
    autoHideMenuBar: true,
    focusable: true,
    skipTaskbar: true,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  audienceWin.webContents.setBackgroundThrottling(false);
  audienceWin.webContents.setAudioMuted(false);
  muteLaptop(true);
  audienceWin.setIgnoreMouseEvents(true, { forward: true });
  audienceWin.on("closed", () => {
    audienceWin = null;
    muteLaptop(false);
  });
  audienceWin.once("ready-to-show", () => {
    const p = pickProjector();
    if (!p) {
      closeAudience();
      return;
    }
    audienceWin.setBounds(p.bounds, false);
    audienceWin.show();
    placeAudienceOnProjector(audienceWin, p);
  });
  audienceWin.webContents.on("did-finish-load", () => {
    muteLaptop(true);
    audienceWin.webContents.setAudioMuted(false);
    pushAllViews();
    pushMedia();
    routeAudienceAudio();
  });
  audienceWin.on("focus", () => {
    if (shellWin && !shellWin.isDestroyed()) shellWin.focus();
  });
  audienceWin.loadURL(deckUrl("audience=1"));
  if (shellWin && !shellWin.isDestroyed()) shellWin.focus();
  return { ok: true };
}

function mountDeck(filePath, id) {
  deckDir = path.dirname(filePath);
  deckFile = path.basename(filePath);
  currentId = id || "";
  slideIdx = 0;
  const info = inspectHtml(filePath);
  slideCount = info.slideCount;
  watchDeck();
}

async function captureCover(id) {
  if (coverWin && !coverWin.isDestroyed()) coverWin.destroy();
  coverWin = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    backgroundColor: "#000000",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await coverWin.loadURL(deckUrl("audience=1"));
    await new Promise((r) => setTimeout(r, 1600));
    if (!coverWin.isDestroyed()) {
      const img = await coverWin.webContents.capturePage();
      store.saveCover(id, img.toPNG());
    }
  } catch (_) {
  } finally {
    if (coverWin && !coverWin.isDestroyed()) coverWin.destroy();
    coverWin = null;
  }
}

function createShell() {
  const primary = screen.getPrimaryDisplay();
  shellWin = new BrowserWindow({
    x: primary.bounds.x + 24,
    y: primary.bounds.y + 24,
    width: Math.min(1440, primary.workArea.width - 48),
    height: Math.min(920, primary.workArea.height - 48),
    autoHideMenuBar: true,
    frame: false,
    minWidth: 860,
    minHeight: 580,
    icon: path.join(__dirname, "assets", "cuedesk.ico"),
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  // Show the first rendered frame, never the empty native window.
  shellWin.once("ready-to-show", () => shellWin && shellWin.show());
  shellWin.on("maximize", sendWindowState);
  shellWin.on("unmaximize", sendWindowState);
  shellWin.on("closed", () => {
    shellWin = null;
    closeAudience();
  });
  shellWin.loadFile(path.join(__dirname, "app.html"));
}

function sendWindowState() {
  if (shellWin && !shellWin.isDestroyed()) shellWin.webContents.send("window:state", { maximized: shellWin.isMaximized() });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "文件",
        submenu: [
          { label: "导入 HTML", accelerator: "CmdOrCtrl+O", click: () => shellWin && shellWin.webContents.send("library:import-request") },
          { label: "播放", accelerator: "F8", click: () => shellWin && shellWin.webContents.send("play:request", "start") },
          { label: "结束播放", accelerator: "F9", click: () => shellWin && shellWin.webContents.send("play:request", "stop") },
          { type: "separator" },
          { role: "quit", label: "退出" },
        ],
      },
    ])
  );
}

async function importHtml() {
  const parent = shellWin && !shellWin.isDestroyed() ? shellWin : undefined;
  const r = await dialog.showOpenDialog(parent, {
    title: "导入 HTML 幻灯片",
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  const info = inspectHtml(filePath);
  const proj = store.upsertByPath(filePath, info);
  mountDeck(filePath, proj.id);
  await captureCover(proj.id);
  return store.get(proj.id) || proj;
}

ipcMain.handle("window:control", (event, action) => {
  if (!shellWin || event.sender !== shellWin.webContents || event.senderFrame !== shellWin.webContents.mainFrame) return;
  if (action === "minimize") shellWin.minimize();
  if (action === "maximize") shellWin.isMaximized() ? shellWin.unmaximize() : shellWin.maximize();
  if (action === "close") shellWin.close();
});
ipcMain.handle("window:state", () => ({ maximized: !!shellWin && shellWin.isMaximized() }));
ipcMain.handle("library:list", () => store.list());
ipcMain.handle("library:import", () => importHtml());
ipcMain.handle("library:remove", (_e, id) => {
  if (currentId === id) {
    closeAudience();
    currentId = "";
    deckFile = "";
    deckDir = "";
  }
  store.remove(id);
  return store.list();
});
ipcMain.handle("notes:get", (_e, id) => store.getNotes(id));
ipcMain.handle("notes:save", (_e, id, pages) => {
  store.saveNotes(id, pages);
  return true;
});
ipcMain.handle("project:open", (_e, id) => {
  const proj = store.get(id);
  if (!proj || !fs.existsSync(proj.htmlPath)) return { ok: false, error: "文件不存在" };
  mountDeck(proj.htmlPath, proj.id);
  return {
    ok: true,
    project: proj,
    url: deckUrl(""),
    nextUrl: deckUrl("preview=next"),
    audienceUrl: deckUrl("audience=1"),
    idx: slideIdx,
    count: slideCount,
  };
});
ipcMain.handle("play:start", () => startAudience());
ipcMain.handle("play:stop", () => {
  closeAudience();
  return { ok: true };
});
ipcMain.handle("sync:set", (_e, i) => {
  setSlideIdx(i);
  pushAllViews();
  return { idx: slideIdx, count: slideCount };
});
ipcMain.handle("sync:get", () => ({ idx: slideIdx, count: slideCount, cast: !!(audienceWin && !audienceWin.isDestroyed()) }));

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);
  store.init(app.getPath("userData"));
  await startServer();
  buildMenu();
  createShell();
  bindDisplayWatch();
});

app.on("window-all-closed", () => {
  if (server) server.close();
  app.quit();
});
