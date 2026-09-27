/**
 * Task health check around a cleanup: the long-running processes of an
 * environment must survive it.
 *
 * Before the first deletion in an environment the watcher records PID 1,
 * AI agents (`claude`, `codex`, `solve`, ...) and build tools (`cargo`,
 * `gradle`, ...) with their start times. After every executed item it lists
 * the processes again. A watched process that is gone, or whose PID now
 * belongs to a process with another start time, stops all further cleaning
 * in that environment. A build that simply finishes also counts as gone:
 * a failing build exits the same way, so the check cannot tell them apart
 * and stays on the safe side.
 */

import { matchingName } from './liveness.js';

/** Agent and task runner process names. */
export const AGENT_NAMES = [
  'claude',
  'codex',
  'solve',
  'hive',
  'gemini',
  'opencode',
  'aider',
  'qwen',
  'start-command',
];

/** Long-running build tools. */
export const BUILD_TOOL_NAMES = [
  'cargo',
  'gradle',
  'gradlew',
  'mvn',
  'bazel',
  'sbt',
  'dotnet',
];

const WATCHED_NAMES = [...AGENT_NAMES, ...BUILD_TOOL_NAMES];

function identity(proc) {
  return {
    pid: proc.pid,
    name: proc.name,
    startTime: proc.startTime ?? null,
  };
}

/**
 * Processes worth watching: PID 1 and every agent or build tool.
 * @param {object[]} processes output of `env.processes()`
 */
export function watchedProcesses(processes) {
  return processes
    .filter((proc) => proc.pid === 1 || matchingName(proc, WATCHED_NAMES))
    .map(identity);
}

/**
 * Watched processes that are missing from `processes` or were replaced by
 * another process with the same PID.
 * @returns {Array<{pid: number, name: string, startTime: string|null,
 *   reason: string}>}
 */
export function lostProcesses(watched, processes) {
  const current = new Map(processes.map((proc) => [proc.pid, proc]));
  const lost = [];
  for (const proc of watched) {
    const now = current.get(proc.pid);
    if (!now) {
      lost.push({ ...proc, reason: 'exited' });
    } else if (
      proc.startTime !== null &&
      (now.startTime ?? null) !== null &&
      now.startTime !== proc.startTime
    ) {
      lost.push({ ...proc, reason: 'restarted with a new start time' });
    }
  }
  return lost;
}

/** Processes of `env`, or null when they cannot be listed. */
async function listProcesses(env) {
  try {
    return (await env.processes?.()) ?? null;
  } catch {
    return null;
  }
}

function describe(lost) {
  return lost
    .map((proc) => `${proc.name} (pid ${proc.pid}) ${proc.reason}`)
    .join(', ');
}

/**
 * Per-environment snapshots and re-checks. `records` is the audit view.
 */
export class HealthWatch {
  constructor() {
    this.records = [];
    this.byEnv = new Map();
  }

  /**
   * Takes the snapshot of an environment once, before its first deletion.
   */
  async baseline(env, item) {
    if (this.byEnv.has(item.env)) {
      return;
    }
    const processes = await listProcesses(env);
    const record = {
      env: item.env,
      envLabel: item.envLabel,
      checks: 0,
      watched: processes ? watchedProcesses(processes) : [],
      available: Boolean(processes),
      lost: [],
      stopped: null,
    };
    this.byEnv.set(item.env, record);
    this.records.push(record);
  }

  /**
   * Why cleaning in the item's environment has stopped, or null.
   */
  stopReason(item) {
    const record = this.byEnv.get(item.env);
    return record?.stopped
      ? `cleaning stopped in this environment: ${record.stopped}`
      : null;
  }

  /**
   * Compares `processes` (null when they cannot be listed) with the
   * snapshot and stops the environment when a watched process is gone.
   * @returns {string|null} the stop reason, when the environment is stopped
   */
  verify(item, processes) {
    const record = this.byEnv.get(item.env);
    if (!record || record.stopped || record.watched.length === 0) {
      return record?.stopped ?? null;
    }
    record.checks += 1;
    if (!processes) {
      record.stopped = 'cannot list processes to verify running tasks';
      return record.stopped;
    }
    const lost = lostProcesses(record.watched, processes);
    if (lost.length === 0) {
      return null;
    }
    record.lost = lost;
    record.stopped = `watched process ${describe(lost)} while cleaning ${item.id}`;
    return record.stopped;
  }

  /**
   * Lists the processes of `env` and verifies them.
   */
  async check(env, item) {
    const record = this.byEnv.get(item.env);
    if (!record || record.stopped || record.watched.length === 0) {
      return record?.stopped ?? null;
    }
    return this.verify(item, await listProcesses(env));
  }
}
