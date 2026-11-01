import { useEffect, useRef } from 'react';

/** A dialog that keeps keyboard focus inside itself, closes on Escape and hands focus back afterwards. */
export function Modal({ labelledBy, onClose, wide, children }: { labelledBy: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const focusable = () => [...(box.current?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]') ?? [])].filter((el) => !el.hasAttribute('disabled'));

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (!box.current?.contains(document.activeElement)) focusable()[0]?.focus();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // page shortcuts must not fire while a dialog is open
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    if (e.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      <div className={`modal ${wide ? 'wide' : ''}`} ref={box}>{children}</div>
    </div>
  );
}
