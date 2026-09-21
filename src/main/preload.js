'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Kejadian yang boleh didengarkan halaman aplikasi. */
const ALLOWED_EVENTS = [
  'live-scan',
  'live-status',
  'sync-start',
  'sync-done',
  'sync-error',
  'device-status',
  'users-synced',
  'autosync-status',
  'progress',
  'menu',
];

contextBridge.exposeInMainWorld('api', {
  /**
   * Panggil satu fungsi di proses utama.
   * @returns {Promise<{ok:boolean, data?:any, error?:string}>}
   */
  call: (name, payload) => ipcRenderer.invoke('api:call', name, payload),

  /** Daftarkan pendengar kejadian; kembalikan fungsi untuk berhenti mendengar. */
  on: (event, callback) => {
    if (!ALLOWED_EVENTS.includes(event)) return () => {};
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on(`event:${event}`, listener);
    return () => ipcRenderer.removeListener(`event:${event}`, listener);
  },
});
