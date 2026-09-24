// lib/cli-resolve.mjs — locate an installed agent CLI and build a READ-ONLY
// planner invocation for it.
//
// Ported from web/src/lib/clis.ts (resolveCli / findBin / searchDirs /
// binCandidates) so the unattended automation worker can spawn the same
// runtimes the web app does. The two trees are otherwise independent — web/
// reaches root only over HTTP — so this is a copy of the resolution logic, not
// an import across the Next.js boundary.
//
// Why the resolution is not just `which`:
//   - On Windows an executable carries an extension (claude.exe, claude.cmd),
//     and only .com/.exe/.bat/.cmd are directly spawnable by child_process.
//   - Windows agent CLIs frequently install under a per-user AppData root and do
//     not reliably add themselves to PATH.
//
// plannerArgs() is the other half: the worker's model calls must be able to READ
// the repo (cv.md, config/profile.yml, modes/*.md) and nothing else. For Claude
// Code that means an explicit allow/deny tool list plus --strict-mcp-config with
// no --mcp-config, which loads ZERO MCP servers — the planner has no use for the
// user's global browser/mail servers and starting them costs seconds per call.
// Other CLIs have no equivalent flag set, so they get their plain prompt form
// and the prompt itself carries the read-only instruction.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The agent runtimes career-ops can delegate to headlessly (AGENTS.md).
 * Mirrors KNOWN in web/src/lib/clis.ts.
 */
export const KNOWN_CLIS = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', run: 'claude -p', args: (p) => ['-p', p] },
  { id: 'codex', name: 'Codex', bin: 'codex', run: 'codex exec', args: (p) => ['exec', p] },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', run: 'gemini -p', args: (p) => ['-p', p] },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', run: 'opencode run', args: (p) => ['run', p] },
  { id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', run: 'copilot -p', args: (p) => ['-p', p] },
  { id: 'qwen', name: 'Qwen CLI', bin: 'qwen', run: 'qwen -p', args: (p) => ['-p', p] },
  { id: 'antigravity', name: 'Antigravity CLI', bin: 'agy', run: 'agy -p', args: (p) => ['-p', p] },
];

function searchDirs() {
  const home = os.homedir();
  const extra = [
    path.join(home, '.local/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.deno/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    extra.push(
      path.join(localAppData, 'agy', 'bin'),                    // Antigravity CLI
      path.join(localAppData, 'Microsoft', 'WindowsApps'),      // winget/Store shims
      path.join(appData, 'npm'),                                // npm global prefix
    );
  }
  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

function binCandidates(bin) {
  if (process.platform !== 'win32') return [bin];
  const pathext = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const exts = pathext
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean)
    // Only extensions child_process.spawn() can execute directly.
    .filter((e) => ['.com', '.exe', '.bat', '.cmd'].includes(e.toLowerCase()));
  // Extensions FIRST, bare name last. clis.ts tries the bare name first, which
  // picks the wrong file for any npm-installed CLI on Windows: npm writes both
  // `codex` (a `#!/bin/sh` shim) and `codex.cmd` into %APPDATA%\npm, and
  // spawn() with shell:false cannot execute the former. Measured on this
  // machine: bare-first resolved codex and gemini to their sh shims.
  // Windows itself resolves in PATHEXT order and treats an extensionless file
  // as non-executable, so this also matches the shell.
  return [...exts.map((ext) => bin + ext), bin];
}

/**
 * Absolute path to an executable named `bin`, or null.
 * @param {string} bin
 * @param {string[]} [dirs]
 * @returns {string | null}
 */
export function findBin(bin, dirs = searchDirs()) {
  for (const dir of dirs) {
    for (const candidate of binCandidates(bin)) {
      const p = path.join(dir, candidate);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Every known CLI with an `installed` flag and resolved path. */
export function detectClis() {
  const dirs = searchDirs();
  return KNOWN_CLIS.map((c) => {
    const found = findBin(c.bin, dirs);
    return { id: c.id, name: c.name, run: c.run, installed: Boolean(found), path: found };
  });
}

/**
 * @param {string} id A KNOWN_CLIS id, e.g. 'claude'.
 * @returns {{ spec: typeof KNOWN_CLIS[number], binPath: string } | null}
 */
export function resolveCli(id) {
  const spec = KNOWN_CLIS.find((c) => c.id === id);
  if (!spec) return null;
  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  return { spec, binPath };
}

/**
 * Like resolveCli, but throws an actionable error instead of returning null —
 * the unattended worker must refuse to run rather than silently skip its model
 * calls.
 * @param {string} id
 */
export function requireCli(id) {
  if (!id) throw new Error('automation.model_cli is not set in config/profile.yml');
  const spec = KNOWN_CLIS.find((c) => c.id === id);
  if (!spec) {
    throw new Error(`unknown automation.model_cli '${id}'; expected one of: ${KNOWN_CLIS.map((c) => c.id).join(', ')}`);
  }
  const resolved = resolveCli(id);
  if (!resolved) {
    throw new Error(`automation.model_cli '${id}' is configured but '${spec.bin}' was not found on PATH or in the usual install locations`);
  }
  return resolved;
}

/** CLIs known to accept the prompt on stdin, so it never enters the argv. */
const STDIN_PROMPT_CLIS = new Set(['claude']);

/** Windows caps a process command line at 32,767 characters, argv and
 *  environment included. Stay well clear of it. */
const ARGV_PROMPT_LIMIT = 24_000;

/**
 * Argument vector for a read-only planner run. For a stdin-capable CLI the
 * prompt is NOT included — pass it to spawnPlanner, which writes it to stdin.
 *
 * Claude Code gets an explicit tool allow/deny list so a model call cannot edit
 * the repo, run commands, or reach the network, plus --strict-mcp-config with no
 * --mcp-config so no MCP servers load (the planner only reads local files, and
 * starting the user's global browser/mail servers costs seconds per call).
 * Every other CLI gets its plain prompt form; the prompt states the read-only
 * expectation itself.
 *
 * @param {typeof KNOWN_CLIS[number]} spec
 * @param {string} [prompt] Ignored for stdin-capable CLIs.
 * @returns {string[]}
 */
export function plannerArgs(spec, prompt = '') {
  if (spec.id === 'claude') {
    // No '-p <prompt>': `claude -p` with no prompt argument reads stdin.
    return [
      '-p',
      '--permission-mode', 'acceptEdits',
      '--strict-mcp-config',
      '--allowedTools', 'Read,Glob,Grep',
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch',
    ];
  }
  return spec.args(prompt);
}

/** True when this CLI takes its prompt on stdin rather than in the argv. */
export function usesStdinPrompt(spec) {
  return STDIN_PROMPT_CLIS.has(spec.id);
}

/**
 * Spawn a read-only planner and collect its stdout.
 *
 * Handles three Windows realities the web app's inline spawn does not:
 *
 *  1. The prompt goes on STDIN for CLIs that support it. The evaluation prompt
 *     embeds whole mode files plus a JD of up to 40,000 characters; Windows caps
 *     a command line at 32,767, so an argv prompt is not merely inelegant, it
 *     fails outright on a real evaluation.
 *  2. A `.cmd`/`.bat` shim cannot be spawned with shell:false on Node >= 18.20
 *     (EINVAL, the CVE-2024-27980 fix), so it is invoked through `cmd.exe /c`.
 *     That is only safe because the prompt is on stdin: the argv carries nothing
 *     but fixed flags, so untrusted job-description text never reaches a shell.
 *     A CLI that needs its prompt in the argv is REFUSED on a .cmd shim rather
 *     than routed through cmd.exe.
 *  3. No shell is used in either path, so nothing interpolates.
 *
 * @param {object} opts
 * @param {typeof KNOWN_CLIS[number]} opts.spec
 * @param {string} opts.binPath
 * @param {string} opts.prompt
 * @param {string} opts.cwd
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {Promise<{ stdout: string, stderr: string, code: number | null, signal: string | null }>}
 */
export async function spawnPlanner({ spec, binPath, prompt, cwd, env = process.env, timeoutMs = 300_000, onLog }) {
  const { spawn } = await import('node:child_process');
  const stdin = usesStdinPrompt(spec);
  const args = plannerArgs(spec, stdin ? '' : prompt);

  if (!stdin && prompt.length > ARGV_PROMPT_LIMIT) {
    throw new Error(`${spec.id} takes its prompt in the argv, and this prompt is ${prompt.length} characters — past the safe Windows command-line budget of ${ARGV_PROMPT_LIMIT}. Use a stdin-capable CLI (claude) for unattended evaluation.`);
  }

  let command = binPath;
  let argv = args;
  const isBatch = /\.(cmd|bat)$/i.test(binPath);
  if (process.platform === 'win32' && isBatch) {
    if (!stdin) {
      throw new Error(`${spec.id} resolved to a .cmd shim (${binPath}) and needs its prompt in the argv. Routing an untrusted prompt through cmd.exe is refused; install a native executable or use a stdin-capable CLI.`);
    }
    command = process.env.COMSPEC || 'cmd.exe';
    argv = ['/d', '/s', '/c', binPath, ...args];
  }

  return new Promise((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      env,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const text = d.toString().trim();
      stderr += text;
      if (text && onLog) onLog(`stderr: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    });

    const killer = setTimeout(() => {
      if (onLog) onLog(`timeout after ${Math.round(timeoutMs / 1000)}s -> SIGTERM`);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(killer);
      done({ stdout, stderr: stderr || error.message, code: null, signal: null });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      done({ stdout, stderr, code, signal });
    });

    if (stdin) {
      child.stdin.on('error', () => { /* closed early; the close handler reports it */ });
      child.stdin.end(prompt, 'utf8');
    }
  });
}
