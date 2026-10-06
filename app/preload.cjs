// The only things the page can reach: named requests to the app, and updates from it.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rudi", {
  invoke: async (name, arg) => {
    const r = await ipcRenderer.invoke(name, arg);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (channel, fn) => {
    if (!["status", "runtime", "preview-log"].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
