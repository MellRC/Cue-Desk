const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  windowControl: (action) => ipcRenderer.invoke("window:control", action),
  windowState: () => ipcRenderer.invoke("window:state"),
  onWindowState: (cb) => ipcRenderer.on("window:state", (_e, state) => cb(state)),
  onImport: (cb) => ipcRenderer.on("library:import-request", () => cb()),
  onPlayRequest: (cb) => ipcRenderer.on("play:request", (_e, action) => cb(action)),
  list: () => ipcRenderer.invoke("library:list"),
  importHtml: () => ipcRenderer.invoke("library:import"),
  remove: (id) => ipcRenderer.invoke("library:remove", id),
  notesGet: (id) => ipcRenderer.invoke("notes:get", id),
  notesSave: (id, pages) => ipcRenderer.invoke("notes:save", id, pages),
  openProject: (id) => ipcRenderer.invoke("project:open", id),
  play: () => ipcRenderer.invoke("play:start"),
  stop: () => ipcRenderer.invoke("play:stop"),
  go: (i) => ipcRenderer.invoke("sync:set", i),
  sync: () => ipcRenderer.invoke("sync:get"),
  onReload: (cb) => {
    ipcRenderer.on("deck:reload", () => cb());
  },
});
