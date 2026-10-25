/**
 * The helper that keeps the owner's Windows PC awake (src/keepAwake.ts). Nothing
 * here runs PowerShell: the command is checked as text, and the spawn is a
 * stand-in, so the suite says the same on Linux and on the owner's PC.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { keepAwakeCommand, keepAwakeScript, startKeepAwake } from '../src/keepAwake.js';

/** What `spawn` hands back, with the two calls the helper makes on it. */
function fakeChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as ChildProcess & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

function setup() {
  const child = fakeChild();
  const spawn = vi.fn(() => child);
  const log = { warn: vi.fn() };
  return { child, spawn, log };
}

describe('keepAwakeCommand', () => {
  it('asks Windows to keep the system, not the screen, awake for as long as the server lives', () => {
    const { command, args } = keepAwakeCommand(1234);
    expect(command).toBe('powershell.exe');
    expect(args.slice(0, -2)).toEqual(['-NoProfile', '-NonInteractive']);
    expect(args.at(-2)).toBe('-EncodedCommand');

    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toBe(keepAwakeScript(1234));
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, no ES_DISPLAY_REQUIRED
    expect(script).toContain('SetThreadExecutionState(0x80000001)');
    expect(script).toContain('while (Get-Process -Id 1234 -ErrorAction SilentlyContinue)');
  });

  it('never hides a window: from a console that would be the owner\'s server window', () => {
    expect(keepAwakeCommand(1234).args).not.toContain('-WindowStyle');
  });
});

describe('startKeepAwake', () => {
  it('does nothing off Windows', () => {
    const { spawn, log } = setup();
    expect(startKeepAwake(log, { platform: 'linux', env: {}, spawn })).toBeNull();
    expect(startKeepAwake(log, { platform: 'darwin', env: {}, spawn })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does nothing on Windows with KEEP_AWAKE=0', () => {
    const { spawn, log } = setup();
    expect(startKeepAwake(log, { platform: 'win32', env: { KEEP_AWAKE: '0' }, spawn })).toBeNull();
    expect(startKeepAwake(log, { platform: 'win32', env: { KEEP_AWAKE: ' 0 ' }, spawn })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts it without a window for this process, and stops it without a warning', () => {
    const { child, spawn, log } = setup();
    const stop = startKeepAwake(log, { platform: 'win32', env: {}, pid: 77, spawn });
    expect(stop).not.toBeNull();
    const { command, args } = keepAwakeCommand(77);
    expect(spawn).toHaveBeenCalledWith(command, args, { stdio: 'ignore', windowsHide: true });
    // the server's exit never waits for it
    expect(child.unref).toHaveBeenCalled();

    stop!();
    expect(child.kill).toHaveBeenCalled();
    child.emit('exit', null, 'SIGTERM');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('says so once when it cannot start, and the server carries on', () => {
    const { child, spawn, log } = setup();
    startKeepAwake(log, { platform: 'win32', env: {}, spawn });
    const missing = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
    child.emit('error', missing);
    child.emit('exit', -4058, null);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith({ err: missing }, 'keep-awake helper failed');
  });

  it('says so when PowerShell gives up on its own (Add-Type locked down)', () => {
    const { child, spawn, log } = setup();
    startKeepAwake(log, { platform: 'win32', env: {}, spawn });
    child.emit('exit', 1, null);
    expect(log.warn).toHaveBeenCalledWith({ code: 1 }, 'keep-awake helper failed');
  });

  it('never throws when spawn itself does', () => {
    const log = { warn: vi.fn() };
    const spawn = vi.fn((): ChildProcess => {
      throw new Error('EPERM');
    });
    expect(startKeepAwake(log, { platform: 'win32', env: {}, spawn })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ err: expect.any(Error) }, 'keep-awake helper failed');
  });
});
