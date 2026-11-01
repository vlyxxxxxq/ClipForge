// Pure helpers for the library page: date groups, multi-select and batch actions.

export function dateLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((day(now) - day(d)) / 86400000);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  if (daysAgo > 1 && daysAgo < 7) return 'This week';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Split an already sorted list into consecutive date groups, keeping its order. */
export function groupByDate<T extends { createdAt: string }>(clips: T[], now: Date): { label: string; clips: T[] }[] {
  const groups: { label: string; clips: T[] }[] = [];
  for (const c of clips) {
    const label = dateLabel(c.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.clips.push(c);
    else groups.push({ label, clips: [c] });
  }
  return groups;
}

export interface Selection { checked: Set<string>; anchor: string | null }

/** What a click does: plain selects one, Ctrl toggles, Shift selects a range from the anchor. */
export function clickSelection(sel: Selection, id: string, ordered: string[], mods: { ctrl?: boolean; shift?: boolean }): Selection {
  if (mods.shift && sel.anchor && ordered.includes(sel.anchor)) {
    const a = ordered.indexOf(sel.anchor), b = ordered.indexOf(id);
    return { checked: new Set(ordered.slice(Math.min(a, b), Math.max(a, b) + 1)), anchor: sel.anchor };
  }
  if (mods.ctrl) {
    const checked = new Set(sel.checked);
    if (checked.has(id)) checked.delete(id); else checked.add(id);
    return { checked, anchor: id };
  }
  return { checked: new Set([id]), anchor: id };
}

/** Run an action on each item in turn; one failure doesn't stop the rest. */
export async function runBatch<T>(items: T[], action: (item: T) => Promise<unknown>): Promise<{ done: number; failed: string[] }> {
  let done = 0;
  const failed: string[] = [];
  for (const item of items) {
    try { await action(item); done++; } catch (e) { failed.push((e as Error).message); }
  }
  return { done, failed };
}
