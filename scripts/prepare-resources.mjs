// Copies ffmpeg.exe/ffprobe.exe (from CLIPFORGE_FFMPEG_DIR or the Scoop install) into resources/ffmpeg
// for packaging, and generates the app icon. Run before `electron-builder`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const src = process.env.CLIPFORGE_FFMPEG_DIR ?? path.join(process.env.USERPROFILE, 'scoop', 'apps', 'ffmpeg', 'current', 'bin');
const dest = path.resolve('resources', 'ffmpeg');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['ffmpeg.exe', 'ffprobe.exe']) {
  if (!fs.existsSync(path.join(src, f))) throw new Error(`Missing ${f} in ${src}; set CLIPFORGE_FFMPEG_DIR`);
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
fs.copyFileSync(path.join(src, '..', 'LICENSE'), path.join(dest, 'FFMPEG-LICENSE.txt'));
const icon = path.resolve('resources', 'icon.png');
if (!fs.existsSync(icon)) {
  execFileSync(path.join(dest, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0f1115:s=256x256', '-vf',
    "drawbox=x=40:y=40:w=176:h=176:color=0xff5a36:t=fill,drawbox=x=96:y=96:w=64:h=64:color=0xffffff:t=fill", '-frames:v', '1', icon]);
}
console.log('resources ready');
