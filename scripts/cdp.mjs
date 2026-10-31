// Dev helper: drive the running app over the DevTools protocol (start it with --remote-debugging-port=9333, or set CDP_PORT).
// node scripts/cdp.mjs shot out.png            -> screenshot
// node scripts/cdp.mjs eval "js expression"     -> evaluate in renderer
const [, , cmd, arg] = process.argv;
const targets = await (await fetch('http://127.0.0.1:'+(process.env.CDP_PORT||9333)+'/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const my = ++id;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener('message', on); res(m.result ?? m.error); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: my, method, params }));
});
if (cmd === 'shot') {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(arg, Buffer.from(r.data, 'base64'));
  console.log('saved', arg);
} else if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.value ?? r, null, 1));
}
ws.close();
