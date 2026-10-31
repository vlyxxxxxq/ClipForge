// Evaluated inside the renderer by scripts/cdp.mjs to exercise the editor like a user would.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k, o = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  const btn = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  btn('9:16').click(); await sleep(100);
  for (let i = 0; i < 10; i++) key('ArrowRight', { shiftKey: true });
  key('s'); await sleep(50);
  for (let i = 0; i < 10; i++) key('ArrowRight', { shiftKey: true });
  key('s'); await sleep(100);
  const seg = document.querySelectorAll('.segment')[1];
  try { seg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: seg.getBoundingClientRect().left + 5, pointerId: 1 })); } catch {}
  await sleep(50);
  key('Delete'); await sleep(100);
  key('Home');
  btn('Add text').click(); await sleep(100);
  setVal(document.querySelector('.inspector textarea'), 'CLUTCH!');
  await sleep(50);
  const vol = document.querySelector('.track input[type=range]');
  setVal(vol, '0.5');
  await sleep(800);
  return { segments: document.querySelectorAll('.segment').length, time: document.querySelector('.timecode').textContent, size: document.querySelector('.inspector .muted.small:last-of-type')?.textContent };
})()
