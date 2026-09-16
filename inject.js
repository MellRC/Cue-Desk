(function () {
  if (window.__presenterInjected) return;
  window.__presenterInjected = true;

  var isAudience = /(?:\?|&)audience=1(?:&|$)/.test(location.search);
  var isPreviewNext = /(?:\?|&)preview=next(?:&|$)/.test(location.search);
  var last = -1;
  var applyingMedia = false;
  var lastMediaSent = 0;
  var casting = false;

  function slideList() {
    var stage = document.getElementById("deck-stage");
    if (stage) {
      var inner = stage.querySelectorAll(":scope > .slide");
      if (inner.length) return Array.prototype.slice.call(inner);
    }
    return Array.prototype.slice.call(document.querySelectorAll(".slide"));
  }

  function readIdx() {
    var list = slideList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].classList.contains("active")) return i;
    }
    return 0;
  }

  function applyVisual(n) {
    var list = slideList();
    if (!list.length) return;
    n = Math.max(0, Math.min(list.length - 1, n));
    list.forEach(function (el, i) {
      el.classList.toggle("active", i === n);
    });
    last = n;
  }

  function applyIdx(n) {
    var list = slideList();
    if (!list.length) return;
    n = Math.max(0, Math.min(list.length - 1, n));
    if (typeof window.goToSlide === "function") {
      window.goToSlide(n);
      last = n;
      return;
    }
    applyVisual(n);
  }

  function pushIdx(n) {
    if (typeof n !== "number" || n === last) return;
    last = n;
    fetch("/__sync?i=" + n).catch(function () {});
  }

  function hookGo() {
    if (typeof window.goToSlide === "function" && !window.goToSlide.__hooked) {
      var orig = window.goToSlide;
      window.goToSlide = function (n) {
        orig.apply(this, arguments);
        if (typeof n !== "number") n = readIdx();
        pushIdx(n);
      };
      window.goToSlide.__hooked = true;
    }
  }

  function reportMeta() {
    fetch("/__meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: slideList().length, title: document.title || "" }),
    }).catch(function () {});
  }

  function injectFsStyle() {
    if (document.getElementById("__cast-fs-style")) return;
    var s = document.createElement("style");
    s.id = "__cast-fs-style";
    s.textContent =
      "video.demo-frame,video{pointer-events:auto!important;z-index:6}" +
      "video.__cast-fs,audio.__cast-fs{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important;transform:none!important}";
    document.documentElement.appendChild(s);
  }

  function setVideoFs(el, on) {
    if (!el) return;
    el.__castFs = !!on;
    if (!isAudience) return;
    if (on) {
      if (!el.__fsHome && el.parentNode) {
        el.__fsHome = { parent: el.parentNode, next: el.nextSibling };
      }
      document.documentElement.appendChild(el);
      el.setAttribute("data-cast-fs", "1");
      el.classList.add("__cast-fs");
    } else {
      el.classList.remove("__cast-fs");
      el.removeAttribute("data-cast-fs");
      el.style.cssText = "";
      var home = el.__fsHome;
      if (home && home.parent) {
        if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(el, home.next);
        else home.parent.appendChild(el);
      }
    }
  }

  function stopAllMedia() {
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) {
      media[i].pause();
      setVideoFs(media[i], false);
      try {
        media[i].currentTime = 0;
      } catch (e) {}
    }
  }

  function locateMedia(el) {
    var list = slideList();
    var slide = 0;
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].contains(el)) {
        slide = i;
        break;
      }
    }
    var all = list[slide] ? list[slide].querySelectorAll("video, audio") : [];
    var mi = 0;
    for (i = 0; i < all.length; i++) {
      if (all[i] === el) mi = i;
    }
    return { slide: slide, mi: mi };
  }

  function sendMedia(el, extra) {
    if (isAudience || isPreviewNext || applyingMedia || !el) return;
    extra = extra || {};
    var loc = el.__castLoc || locateMedia(el);
    if (!el.__castLoc && loc) el.__castLoc = loc;
    var body = {
      playing: !el.paused,
      t: el.currentTime || 0,
      slide: loc.slide,
      mi: loc.mi,
    };
    if (extra.fullscreen !== undefined) {
      el.__castFs = !!extra.fullscreen;
      body.fullscreen = !!extra.fullscreen;
    } else if (el.__castFs) {
      body.fullscreen = true;
    }
    fetch("/__media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(function () {});
  }

  function patchFsApi() {
    if (window.__castFsPatched) return;
    window.__castFsPatched = true;
    function wrapVideo(name) {
      var proto = HTMLVideoElement.prototype;
      var orig = proto[name];
      if (typeof orig !== "function") return;
      proto[name] = function () {
        if (!this.__castLoc) this.__castLoc = locateMedia(this);
        setVideoFs(this, true);
        sendMedia(this, { fullscreen: true });
        try {
          return orig.apply(this, arguments);
        } catch (e) {
          return Promise.resolve();
        }
      };
    }
    wrapVideo("requestFullscreen");
    wrapVideo("webkitRequestFullscreen");
    wrapVideo("webkitEnterFullscreen");
    wrapVideo("webkitEnterFullScreen");
    var origElFs = Element.prototype.requestFullscreen;
    if (typeof origElFs === "function") {
      Element.prototype.requestFullscreen = function () {
        if (this && (this.tagName === "VIDEO" || this.tagName === "AUDIO")) {
          if (!this.__castLoc) this.__castLoc = locateMedia(this);
          setVideoFs(this, true);
          sendMedia(this, { fullscreen: true });
        }
        try {
          return origElFs.apply(this, arguments);
        } catch (e) {
          return Promise.resolve();
        }
      };
    }
    function wrapExit(obj, name) {
      if (!obj) return;
      var orig = obj[name];
      if (typeof orig !== "function") return;
      obj[name] = function () {
        var el = document.querySelector("video.__cast-fs") || document.fullscreenElement;
        if (el && el.tagName === "VIDEO") {
          setVideoFs(el, false);
          sendMedia(el, { fullscreen: false });
        }
        try {
          return orig.apply(this, arguments);
        } catch (e) {
          return Promise.resolve();
        }
      };
    }
    wrapExit(Document.prototype, "exitFullscreen");
    wrapExit(Document.prototype, "webkitExitFullscreen");
  }

  function hookMedia() {
    if (isPreviewNext) return;
    injectFsStyle();
    patchFsApi();
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) {
      var m = media[i];
      if (m.__mediaHooked) continue;
      m.__mediaHooked = true;
      m.removeAttribute("playsinline");
      m.controls = true;
      m.style.pointerEvents = "auto";
      if (isAudience) continue;
      m.addEventListener("play", function () {
        this.muted = false;
        sendMedia(this);
      });
      m.addEventListener("pause", function () {
        sendMedia(this);
      });
      m.addEventListener("seeked", function () {
        sendMedia(this);
      });
      m.addEventListener("timeupdate", function () {
        if (this.paused) return;
        var now = Date.now();
        if (now - lastMediaSent < 400) return;
        lastMediaSent = now;
        sendMedia(this);
      });
      m.addEventListener("webkitbeginfullscreen", function () {
        setVideoFs(this, true);
        sendMedia(this, { fullscreen: true });
      });
      m.addEventListener("webkitendfullscreen", function () {
        setVideoFs(this, false);
        sendMedia(this, { fullscreen: false });
        restoreAfterFs();
      });
    }
  }

  window.__mediaApply = function (cmd) {
    if (!cmd) return;
    applyingMedia = true;
    var list = slideList();
    var slide = list[cmd.slide];
    var m = slide && slide.querySelectorAll("video, audio")[cmd.mi];
    if (!m && cmd.fullscreen) {
      m = document.querySelector("video.__cast-fs") || document.querySelector("video, audio");
    }
    if (m) {
      try {
        if (typeof cmd.t === "number" && Math.abs((m.currentTime || 0) - cmd.t) > 0.4) {
          m.currentTime = cmd.t;
        }
      } catch (e) {}
      if (cmd.playing) {
        var p = m.play();
        if (p && p.catch) p.catch(function () {});
      } else {
        m.pause();
      }
      setVideoFs(m, !!cmd.fullscreen);
    } else {
      stopAllMedia();
    }
    setTimeout(function () {
      applyingMedia = false;
    }, 50);
  };

  window.__deckGo = function (n) {
    if (typeof n !== "number") return;
    if (isPreviewNext) {
      applyVisual(n + 1);
      return;
    }
    var same = n === last;
    if (typeof window.goToSlide === "function") window.goToSlide(n);
    else applyVisual(n);
    last = n;
    if (!same) {
      stopAllMedia();
      hookMedia();
    }
  };
  window.__audienceGo = window.__deckGo;

  window.addEventListener("load", reportMeta);
  window.addEventListener("load", hookMedia);
  setTimeout(reportMeta, 900);
  setTimeout(hookMedia, 900);

  if (isAudience) {
    document.title = "投屏";
    setInterval(function () {
      fetch("/__sync")
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (!d || typeof d.idx !== "number") return;
          if (d.idx === last) return;
          window.__deckGo(d.idx);
        })
        .catch(function () {});
    }, 80);
    return;
  }

  if (isPreviewNext) {
    document.title = "下一页";
    setInterval(function () {
      fetch("/__sync")
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (!d || typeof d.idx !== "number") return;
          var next = Math.max(0, Math.min(slideList().length - 1, d.idx + 1));
          if (next !== last) applyVisual(next);
        })
        .catch(function () {});
    }, 120);
    return;
  }

  hookGo();
  window.addEventListener("load", hookGo);
  var fsExitAt = 0;
  function restoreAfterFs() {
    fsExitAt = Date.now();
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) {
      try {
        media[i].blur();
      } catch (e) {}
    }
    try {
      document.body.focus({ preventScroll: true });
    } catch (e) {}
    last = -1;
    var n = readIdx();
    if (typeof window.goToSlide === "function") window.goToSlide(n);
    pushIdx(n);
  }
  function syncNativeFs() {
    var el = document.fullscreenElement || document.webkitFullscreenElement;
    if (el && (el.tagName === "VIDEO" || el.tagName === "AUDIO")) {
      if (!el.__castLoc) el.__castLoc = locateMedia(el);
      if (!el.__castFs) {
        el.__castFs = true;
        sendMedia(el, { fullscreen: true });
      }
      return;
    }
    var hadFs = false;
    var media = document.querySelectorAll("video, audio");
    for (var i = 0; i < media.length; i++) {
      if (media[i].__castFs) {
        media[i].__castFs = false;
        sendMedia(media[i], { fullscreen: false });
        hadFs = true;
      }
    }
    if (hadFs) restoreAfterFs();
  }
  document.addEventListener("fullscreenchange", syncNativeFs);
  document.addEventListener("webkitfullscreenchange", syncNativeFs);
  setInterval(function () {
    var el = document.fullscreenElement || document.webkitFullscreenElement;
    if (el && (el.tagName === "VIDEO" || el.tagName === "AUDIO") && !el.__castFs) {
      if (!el.__castLoc) el.__castLoc = locateMedia(el);
      el.__castFs = true;
      sendMedia(el, { fullscreen: true });
    }
  }, 250);
  document.addEventListener(
    "click",
    function (e) {
      if (Date.now() - fsExitAt < 800) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
  document.addEventListener(
    "keydown",
    function (e) {
      var k = e.key;
      if (k !== "ArrowRight" && k !== "ArrowLeft" && k !== "PageDown" && k !== "PageUp") return;
      var t = e.target;
      if (!t || (t.tagName !== "VIDEO" && t.tagName !== "AUDIO")) return;
      e.preventDefault();
      if (e.__odDeckKeyHandled) return;
      e.__odDeckKeyHandled = true;
      var n = readIdx();
      if (k === "ArrowRight" || k === "PageDown") n += 1;
      else n -= 1;
      last = -1;
      if (typeof window.goToSlide === "function") window.goToSlide(n);
      else pushIdx(n);
    },
    true
  );
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var fs = document.querySelector("video.__cast-fs, audio.__cast-fs");
    if (!fs) return;
    setVideoFs(fs, false);
    sendMedia(fs);
  });
  document.addEventListener(
    "keydown",
    function () {
      setTimeout(function () {
        hookGo();
        pushIdx(readIdx());
      }, 30);
    },
    true
  );
  setInterval(function () {
    fetch("/__sync")
      .then(function (r) {
        return r.json();
      })
        .then(function (d) {
          if (!d) return;
          if (typeof d.cast === "boolean") casting = d.cast;
          if (d && typeof d.idx === "number" && d.idx !== last) applyIdx(d.idx);
        })
      .catch(function () {});
  }, 120);
})();
