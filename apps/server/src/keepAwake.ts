/**
 * Keeps the owner's Windows PC from going to sleep while the server runs.
 *
 * A laptop sleeps after 15-30 idle minutes, and a sleeping server misses the
 * phones' last syncs of the evening and the photo that answers an itiraz. The
 * scheduler gives both an hour after it wakes (`nextBootAt`), but nobody can play
 * while it sleeps. Windows keeps a PC awake while some thread asks it to
 * (`SetThreadExecutionState`), and only native code can ask, so a hidden
 * PowerShell does it for us: no dependency, nothing to install. It asks for the
 * system only, not the display, so the screen still goes dark. A closed lid
 * still sleeps; README "Bilgisayar uyumasın" says how to stop that.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED, written as C# so PowerShell 5.1 never reads it as a negative int. */
const AWAKE_FLAGS = '0x80000001';

/**
 * The PowerShell that holds the PC awake for as long as process `pid` lives. It
 * polls rather than waiting to be told: a server killed outright (Task Manager,
 * `npm run internet`'s kill after 15 s) never gets to stop it.
 */
export function keepAwakeScript(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -Namespace Koydum -Name Power -MemberDefinition '[DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags); public static bool StayAwake() { return SetThreadExecutionState(${AWAKE_FLAGS}) != 0; }'`,
    'if (-not [Koydum.Power]::StayAwake()) { exit 1 }',
    // the flag belongs to this thread and holds until it ends: this loop is that thread
    `while (Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
  ].join('\n');
}

/**
 * How to start it. -EncodedCommand (base64 of UTF-16LE) because the script's
 * quotes would not survive Windows' command-line quoting. No -WindowStyle
 * Hidden: from a console it hides the console it runs in, which can be the
 * owner's server window; `windowsHide` with no inherited stdio gives it a
 * console of its own that is never shown.
 */
export function keepAwakeCommand(pid: number): { command: string; args: string[] } {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(keepAwakeScript(pid), 'utf16le').toString('base64')],
  };
}

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The process the PC stays awake for; this one by default. */
  pid?: number;
  /** Stand-in for `child_process.spawn` in the tests. */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/**
 * Starts the helper on Windows unless KEEP_AWAKE=0, and returns the function
 * that stops it; null when there is nothing to stop. Never fatal: a PC that
 * cannot be held awake still runs the server, and the owner's window says so
 * once.
 */
export function startKeepAwake(
  log: Pick<FastifyBaseLogger, 'warn'>,
  options: KeepAwakeOptions = {},
): (() => void) | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32') return null;
  const setting = env.KEEP_AWAKE?.trim().toLowerCase();
  if (setting === '0' || setting === 'false') return null;

  let stopping = false;
  let warned = false;
  const warn = (fields: Record<string, unknown>): void => {
    if (stopping || warned) return;
    warned = true;
    log.warn(fields, 'keep-awake helper failed');
  };

  const { command, args } = keepAwakeCommand(options.pid ?? process.pid);
  const start: NonNullable<KeepAwakeOptions['spawn']> = options.spawn ?? spawn;
  let child: ChildProcess;
  try {
    child = start(command, args, { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    warn({ err });
    return null;
  }
  // no powershell.exe on the PATH
  child.on('error', (err) => warn({ err }));
  // Add-Type refused (a school laptop that locks PowerShell down), or somebody
  // ended it: either way nothing holds the PC awake any more
  child.on('exit', (code) => warn({ code }));
  // the server's own exit must never wait for it
  child.unref();

  return () => {
    stopping = true;
    child.kill();
  };
}
