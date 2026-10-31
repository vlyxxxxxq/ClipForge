import fs from 'node:fs';
import path from 'node:path';

// Simple rotating file logger. Never logs clip titles or file contents; paths are logged
// relative to the user's home where possible.
let logFile: string | null = null;
const home = process.env.USERPROFILE ?? '';

export function initLogger(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'clipforge.log');
  try {
    if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, path.join(dir, 'clipforge.old.log'));
  } catch { /* no log yet */ }
}

function write(level: string, scope: string, msg: string) {
  const line = `${new Date().toISOString()} ${level} [${scope}] ${home ? msg.split(home).join('~') : msg}\n`;
  if (level !== 'DEBUG') process.stdout.write(line);
  if (logFile) fs.appendFile(logFile, line, () => {});
}

export const log = (scope: string) => ({
  info: (m: string) => write('INFO', scope, m),
  warn: (m: string) => write('WARN', scope, m),
  error: (m: string) => write('ERROR', scope, m),
  debug: (m: string) => write('DEBUG', scope, m),
});

export const logFilePath = () => logFile;
