/**
 * dsh-openfrp — running a child process and reading its output, safely.
 *
 * **Never use `execFile` or `spawn` with piped stdio here.** Measured: under the
 * default confined DSH sandbox, a child spawned with `stdio: 'pipe'` fails with
 * `EPERM` — programs in a confined token cannot open the named pipe Node uses to
 * read a child's output. The same measurement shows `ignore` and **file
 * descriptors** work.
 *
 * So capturing output means: redirect the child's stdout and stderr to a real
 * file (two append descriptors on one file, which also keeps both streams in
 * arrival order), wait for exit, then read the file.
 *
 * 运行子进程并读取输出。**绝不用管道 stdio** —— 受限沙箱下 Node 读子进程输出的命名管道
 * 会 EPERM。改为把 stdout/stderr 重定向到真实文件，退出后再读。
 *
 * @module dsh-openfrp/exec
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Run a command, capture everything it prints, and resolve once it exits.
 *
 * @returns {Promise<{ok:boolean, code?:number|null, stdout:string, error?:string}>}
 */
export function runCapture(command, args, { timeoutMs = 10_000, cwd = undefined } = {}) {
  return new Promise(resolve => {
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openfrp-cap-'));
    } catch (error) {
      resolve({ ok: false, stdout: '', error: `无法创建临时目录：${error?.message ?? error}` });
      return;
    }
    const file = path.join(dir, 'out.txt');

    let fd;
    try {
      fd = fs.openSync(file, 'w');
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ ok: false, stdout: '', error: String(error?.message ?? error) });
      return;
    }

    const finish = result => {
      let stdout = '';
      try {
        stdout = fs.readFileSync(file, 'utf8');
      } catch {
        /* nothing captured */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      resolve({ ...result, stdout });
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        ...(cwd === undefined ? {} : { cwd }),
      });
    } catch (error) {
      fs.closeSync(fd);
      finish({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    fs.closeSync(fd);

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('error', error => {
      clearTimeout(timer);
      finish({ ok: false, error: String(error?.message ?? error) });
    });
    child.on('exit', code => {
      clearTimeout(timer);
      finish({ ok: code === 0, code });
    });
  });
}

/**
 * Fire-and-forget a command with no output capture at all.
 * Used where we only care that it ran (e.g. `taskkill`).
 */
export function runQuiet(command, args, { cwd = undefined } = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: 'ignore',
        windowsHide: true,
        ...(cwd === undefined ? {} : { cwd }),
      });
    } catch {
      resolve({ ok: false });
      return;
    }
    child.on('exit', code => resolve({ ok: code === 0, code }));
    child.on('error', () => resolve({ ok: false }));
  });
}
