// Narrow, typed bridge. The renderer never gets Node or ipcRenderer directly.
import { contextBridge, ipcRenderer } from 'electron';

const invoke = (ch: string) => (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
const channels = [
  'app:info', 'app:openLogs', 'app:quit', 'settings:get', 'settings:set', 'capture:status', 'capture:start', 'capture:stop', 'capture:pause',
  'capture:resume', 'capture:save', 'capture:screenshot', 'capture:devices', 'library:list', 'library:refresh', 'library:update',
  'library:delete', 'library:reveal', 'library:relink', 'library:import', 'editor:load', 'editor:waveform', 'editor:save', 'export:start',
  'export:cancel', 'export:list', 'export:reveal', 'recovery:list', 'recovery:recover', 'recovery:discard', 'dialog:folder',
] as const;

const api: Record<string, (...a: unknown[]) => Promise<any>> = {};
for (const ch of channels) api[ch] = invoke(ch);

contextBridge.exposeInMainWorld('clipforge', {
  call: (ch: string, ...args: unknown[]) => {
    if (!(channels as readonly string[]).includes(ch)) return Promise.reject(new Error('Unknown channel'));
    return api[ch](...args);
  },
  on: (ch: 'event' | 'capture-status', fn: (payload: unknown) => void) => {
    if (ch !== 'event' && ch !== 'capture-status') return () => {};
    const l = (_e: unknown, p: unknown) => fn(p);
    ipcRenderer.on(ch, l);
    return () => ipcRenderer.removeListener(ch, l);
  },
});
