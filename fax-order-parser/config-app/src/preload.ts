import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('faxParserApi', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  readLog: () => ipcRenderer.invoke('log:read'),
  serviceStatus: () => ipcRenderer.invoke('service:status'),
  serviceStart: () => ipcRenderer.invoke('service:start'),
  serviceStop: () => ipcRenderer.invoke('service:stop'),
  openFolder: (p: string) => ipcRenderer.invoke('shell:openFolder', p),
});
