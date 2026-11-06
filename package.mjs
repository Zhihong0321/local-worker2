// The worker download: worker/ zipped with a worker.env that already names this
// service and carries the worker key, so a PC needs only unzip and double-click.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PACKAGE_NAME = 'LocalGmapWorker.zip';
const DIR = path.resolve(import.meta.dirname, 'worker');

/** Files of the package, as [path in worker/, path in the zip]. */
const FILES = [
  ['Start Local Gmap Worker.cmd', 'Start Local Gmap Worker.cmd'],
  ['Enable autostart.cmd', 'Enable autostart.cmd'],
  ['Disable autostart.cmd', 'Disable autostart.cmd'],
  ['LinkedIn sign in.cmd', 'LinkedIn sign in.cmd'],
  ['README.txt', 'README.txt'],
  ['worker.ps1', 'app/worker.ps1'],
  ['fetch.py', 'app/fetch.py'],
  ['audit.py', 'app/audit.py'],
  ['audit_ai_access.py', 'app/audit_ai_access.py'],
  ['audit_content.py', 'app/audit_content.py'],
  ['audit_onpage.py', 'app/audit_onpage.py'],
  ['audit_schema.py', 'app/audit_schema.py'],
  ['run-handler.mjs', 'app/run-handler.mjs'],
  ['linkedin_job.py', 'app/linkedin_job.py'],
  ['linkedin_login.py', 'app/linkedin_login.py'],
  ['linkedin_signin.ps1', 'app/linkedin_signin.ps1'],
];

const DOS_EPOCH = { time: 0, date: (2026 - 1980) << 9 | 1 << 5 | 1 };

/** A plain deflate zip. UTF-8 names, no extras, no comment. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_EPOCH.time, 10);
    local.writeUInt16LE(DOS_EPOCH.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_EPOCH.time, 12);
    central.writeUInt16LE(DOS_EPOCH.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Windows line endings, and a BOM on the script: PowerShell 5.1 reads a BOM-less file as ANSI. */
function forWindows(name, data) {
  const text = data.toString('utf8').replace(/\r?\n/g, '\r\n');
  return Buffer.from((name.endsWith('.ps1') ? '﻿' : '') + text, 'utf8');
}

export function packageZip(hubUrl, workerKey, dir = DIR) {
  const env = [
    '# Local Gmap Worker settings. Keep this file private: the key lets a PC take Maps jobs from the service.',
    'HUB_URL=' + hubUrl.replace(/\/+$/, ''),
    'WORKER_KEY=' + workerKey,
    '# WORKER_NAME=pc-office-1',
    '# GMAP_PACE_MS=500',
    '# WEB_FETCH=off',
    '# LINKEDIN_PYTHON=C:\\path\\to\\venv\\Scripts\\python.exe',
    '# LINKEDIN_SESSION=C:\\path\\to\\linkedin_session.json',
    '',
  ].join('\n');
  const entries = FILES.map(([from, to]) => ({ name: 'LocalGmapWorker/' + to, data: forWindows(to, fs.readFileSync(path.join(dir, from))) }));
  entries.push({ name: 'LocalGmapWorker/worker.env', data: forWindows('worker.env', Buffer.from(env, 'utf8')) });
  return zip(entries);
}
