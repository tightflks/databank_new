import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CSV_ROOT, download, dropboxConfigured } from './dropbox';
import { reportError } from './alerts';

// The weekly Reflex zip -> CSV conversion and the property-history update, run by the site itself.
// These are Devin's scripts from tareq-dashboard (tools/rxd), unchanged; they used to run only when
// someone clicked "Run workflow" on GitHub, so a week went missing when nobody did (Sep 23).
// dropbox_sync.py is idempotent (a week is skipped once its zip's content_hash is in the manifest),
// so running it on every sync costs one Dropbox folder listing when there's nothing new.

const TOOLS = path.join(__dirname, '../../tools/rxd');
const HISTORY_TYPES = ['APTS', 'FRANCHIS', 'IND', 'LANDSALE', 'OFFSHOP'];
let running = false;

function run(script: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(TOOLS, script), ...args], { cwd, env: process.env });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else reject(new Error(`${script} exited ${code}: ${log.slice(-800)}`));
    });
  });
}

export async function convertNewWeeks(): Promise<{ weeks: string[] } | null> {
  if (running || !dropboxConfigured() || process.env.DROPBOX_LOCAL_CSV_ROOT || !fs.existsSync(TOOLS)) return null;
  running = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'databank-rxd-'));
  try {
    const syncLog = await run('dropbox_sync.py', ['--out', tmp, '--upload'], tmp);
    const weeks = fs.readdirSync(tmp).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if (!weeks.length) return { weeks };
    console.log(`✅ Weekly conversion: ${weeks.join(', ')}\n${syncLog.trim()}`);
    // history.py folds only the weeks it hasn't seen into the existing history, so start it from
    // the current files in Dropbox.
    fs.mkdirSync(path.join(tmp, 'history'));
    for (const t of HISTORY_TYPES) {
      const res = await download(`${CSV_ROOT}/history/${t}.json.gz`);
      // Without the existing file, history.py would start that type over from this one week and
      // overwrite years of history in Dropbox, so stop instead.
      if (!res) throw new Error(`history/${t}.json.gz could not be downloaded; history not updated (the weekly CSVs are in)`);
      fs.writeFileSync(path.join(tmp, 'history', `${t}.json.gz`), Buffer.from(await res.arrayBuffer()));
    }
    const histLog = await run('history.py', ['--csv', tmp, '--upload'], tmp);
    console.log(`✅ Property history updated\n${histLog.trim()}`);
    return { weeks };
  } catch (e) {
    reportError('Weekly data conversion', e);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    running = false;
  }
}
