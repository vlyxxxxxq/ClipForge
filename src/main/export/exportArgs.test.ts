import { describe, expect, it } from 'vitest';
import { buildExportArgs, filterPath, parseProgress } from './exportArgs';
import { createProject, removeSegment, splitAt } from '../../shared/project';

const src = { path: 'C:\\clips\\a.mp4', duration: 30, width: 1920, height: 1080, audioTracks: ['Desktop', 'Microphone'] };
const opts = { resolution: '1080p' as const, fps: 'source' as const, quality: 'high' as const, fileName: 'x' };

function build(p = createProject('c', src), o = opts) {
  return buildExportArgs({ project: p, options: o, sourceFps: 60, outFile: 'out.mp4', textFiles: p.texts.map((_, k) => `C:\\t\\text${k}.txt`), fontFile: 'C:\\Windows\\Fonts\\segoeuib.ttf' });
}
const graph = (a: string[]) => a[a.indexOf('-filter_complex') + 1];

describe('export args', () => {
  it('builds a vertical, split, text and mixed-audio export', () => {
    let p = splitAt(splitAt(createProject('c', src), 10), 20);
    p = removeSegment(p, p.segments[1].id);
    p = { ...p, aspect: '9:16', audio: { desktopVolume: 0.5, desktopMuted: false, micVolume: 1.5, micMuted: false },
      texts: [{ id: 't', text: "it's: here", x: 0.5, y: 0.2, size: 0.05, color: '#ff0000', start: 1, end: 4 }] };
    const r = build(p);
    const g = graph(r.args);
    expect(r).toMatchObject({ width: 1080, height: 1920, duration: 20, hasAudio: true });
    expect(g).toContain('[0:v]split=2[vs0][vs1]');
    expect(g).toContain('trim=start=20:end=30');
    expect(g).toContain('[v0][a0_0][a1_0][v1][a0_1][a1_1]concat=n=2:v=1:a=2');
    expect(g).toContain('crop=608:1080:656:0,scale=1080:1920');
    expect(g).toContain("textfile='C\\:/t/text0.txt'");
    expect(g).toContain('fontsize=96');
    expect(g).toContain("enable='between(t\\,1\\,4)'");
    expect(g).toContain('volume=0.5[am0]');
    expect(g).toContain('amix=inputs=2');
    expect(r.args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '+faststart']));
    expect(r.args[r.args.length - 1]).toBe('out.mp4');
  });

  it('drops muted tracks and omits audio when everything is muted', () => {
    const p = createProject('c', src);
    const one = build({ ...p, audio: { ...p.audio, micMuted: true } });
    expect(graph(one.args)).toContain('concat=n=1:v=1:a=1');
    expect(graph(one.args)).not.toContain('0:a:1');
    const none = build({ ...p, audio: { ...p.audio, micMuted: true, desktopMuted: true } });
    expect(none.hasAudio).toBe(false);
    expect(none.args).not.toContain('-c:a');
  });

  it('respects fps and quality options', () => {
    const r = build(undefined, { ...opts, fps: 30 as any, quality: 'low' });
    expect(graph(r.args)).toContain('fps=30');
    expect(r.args[r.args.indexOf('-crf') + 1]).toBe('28');
  });

  it('escapes filter paths', () => {
    expect(filterPath("C:\\a'b\\c.txt")).toBe("'C\\:/a'\\''b/c.txt'");
  });

  it('parses progress', () => {
    expect(parseProgress('frame=10\nout_time_us=1500000\nprogress=continue\n')).toEqual({ outTime: 1.5, ended: false });
    expect(parseProgress('progress=end').ended).toBe(true);
  });
});
