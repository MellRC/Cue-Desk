const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

let root = "";

function init(userData) {
  root = path.join(userData, "library");
  fs.mkdirSync(path.join(root, "covers"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  if (!fs.existsSync(libFile())) {
    writeLib({ projects: [] });
  }
}

function libFile() {
  return path.join(root, "library.json");
}

function readLib() {
  try {
    return JSON.parse(fs.readFileSync(libFile(), "utf8"));
  } catch (_) {
    return { projects: [] };
  }
}

function writeLib(data) {
  fs.writeFileSync(libFile(), JSON.stringify(data, null, 2), "utf8");
}

function notesFile(id) {
  return path.join(root, "notes", id + ".json");
}

function coverFile(id) {
  return path.join(root, "covers", id + ".png");
}

async function list() {
  let data;
  try { data = JSON.parse(await fs.promises.readFile(libFile(), "utf8")); }
  catch (_) { return []; }
  return Promise.all((data.projects || []).map(async (p) => {
    const [exists, coverStat] = await Promise.all([
      p.htmlPath ? fs.promises.access(p.htmlPath).then(() => true, () => false) : false,
      fs.promises.stat(coverFile(p.id)).catch(() => null),
    ]);
    return {
      ...p,
      missing: !exists,
      // Let Chromium load and cache images instead of sending PNG bytes over IPC.
      cover: coverStat ? pathToFileURL(coverFile(p.id)).href + "?v=" + coverStat.mtimeMs : "",
    };
  }));
}

function get(id) {
  return (readLib().projects || []).find((p) => p.id === id) || null;
}

function upsertByPath(htmlPath, extra) {
  const data = readLib();
  const abs = path.resolve(htmlPath);
  let proj = (data.projects || []).find((p) => path.resolve(p.htmlPath) === abs);
  const now = Date.now();
  if (!proj) {
    proj = {
      id: crypto.randomUUID(),
      htmlPath: abs,
      title: extra.title || path.basename(abs, path.extname(abs)),
      slideCount: extra.slideCount || 0,
      createdAt: now,
      updatedAt: now,
    };
    data.projects.unshift(proj);
  } else {
    proj.htmlPath = abs;
    if (extra.title) proj.title = extra.title;
    if (extra.slideCount) proj.slideCount = extra.slideCount;
    proj.updatedAt = now;
  }
  writeLib(data);
  return proj;
}

function update(id, patch) {
  const data = readLib();
  const proj = (data.projects || []).find((p) => p.id === id);
  if (!proj) return null;
  Object.assign(proj, patch, { updatedAt: Date.now() });
  writeLib(data);
  return proj;
}

function remove(id) {
  const data = readLib();
  data.projects = (data.projects || []).filter((p) => p.id !== id);
  writeLib(data);
  try {
    fs.unlinkSync(notesFile(id));
  } catch (_) {}
  try {
    fs.unlinkSync(coverFile(id));
  } catch (_) {}
}

function getNotes(id) {
  try {
    return JSON.parse(fs.readFileSync(notesFile(id), "utf8"));
  } catch (_) {
    return { pages: {} };
  }
}

function saveNotes(id, pages) {
  fs.writeFileSync(notesFile(id), JSON.stringify({ pages: pages || {} }, null, 2), "utf8");
  update(id, {});
}

function saveCover(id, pngBuffer) {
  fs.writeFileSync(coverFile(id), pngBuffer);
  update(id, {});
}

module.exports = {
  init,
  list,
  get,
  upsertByPath,
  update,
  remove,
  getNotes,
  saveNotes,
  saveCover,
  coverFile,
};
