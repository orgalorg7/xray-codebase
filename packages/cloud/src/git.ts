import { spawn } from "node:child_process";
import { devNull } from "node:os";

export type GitOptions = {
  cwd?: string;
  /** Transport protocols git may use (`GIT_ALLOW_PROTOCOL`), such as `https`. */
  protocols: string;
  timeoutMs?: number;
  /** Receives stderr as it arrives (progress output). */
  onStderr?: (text: string) => void;
  signal?: AbortSignal;
};

/**
 * Settings for every git command run on untrusted repositories: symbolic links become plain
 * files (so nothing can point outside the checkout), and hooks, fsmonitor, submodules and line
 * ending conversion are off.
 */
const SAFE_CONFIG = [
  "core.symlinks=false",
  `core.hooksPath=${devNull}`,
  "core.fsmonitor=false",
  "core.autocrlf=false",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
  "protocol.version=2",
  // Always index received packs, so progress reports the bytes downloaded (for the size limit).
  "fetch.unpackLimit=1",
  "advice.detachedHead=false",
].flatMap((setting) => ["-c", setting]);

/**
 * A clean environment for git: none of the server's own variables (tokens, credentials), no
 * user or system config, no prompts, no LFS downloads, and only the allowed protocols.
 */
export function gitEnv(protocols: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? devNull,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_ALLOW_PROTOCOL: protocols,
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Runs git with the safe settings and environment; resolves with stdout. */
export function git(args: string[], options: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_CONFIG, ...args], {
      cwd: options.cwd,
      env: gitEnv(options.protocols),
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-8000);
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const lines = stderr
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      // The first "fatal:" line says what went wrong; later lines are generic advice.
      const fatal = lines.find((line) => /^(fatal|error):/.test(line));
      const reason = timedOut
        ? `timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)} s`
        : (fatal ?? lines.at(-1) ?? `exit ${code ?? signal}`);
      reject(new GitError(`git ${args[0]} failed: ${reason}`, stderr));
    });
  });
}
