/** Scan cancellation and deadlines shared by local and remote adapters. */
export function checkSignal(signal) {
  if (signal?.aborted) {
    const error = new Error(signal.reason?.message ?? 'scan aborted');
    error.name = 'AbortError';
    throw error;
  }
}

export function signalExecutor(executor, signal, deadline = Infinity) {
  const base = executor.unscoped ?? executor;
  return {
    ...executor,
    unscoped: executor.unscoped ?? executor,
    signal,
    spawn: (argv, options = {}) => {
      checkSignal(options.signal ?? signal);
      return base.spawn(argv, {
        ...options,
        signal: options.signal ?? signal,
        timeoutMs: Math.max(
          1,
          Math.min(options.timeoutMs ?? 600000, deadline - Date.now())
        ),
      });
    },
    run: async (argv, options = {}) => {
      const active = options.signal ?? signal;
      checkSignal(active);
      const result = await base.run(argv, {
        ...options,
        signal: active,
        timeoutMs: Math.max(
          1,
          Math.min(options.timeoutMs ?? 600000, deadline - Date.now())
        ),
      });
      checkSignal(active);
      return result;
    },
  };
}

/** Restore adapter state so later clean/re-scan calls never inherit an old abort. */
export async function environmentScope(
  env,
  signal,
  operation,
  deadline = Infinity
) {
  const original = {
    executor: env.executor,
    signal: env.signal,
    deadline: env.deadline,
  };
  const probe = env.probeExecutor;
  env.signal = signal;
  env.deadline = deadline;
  env.executor = signalExecutor(env.executor, signal, deadline);
  if (probe) {
    env.probeExecutor = signalExecutor(probe, signal, deadline);
  }
  const layerExecutor = env.writableLayer?.docker?.executor;
  if (layerExecutor) {
    env.writableLayer.docker.executor = signalExecutor(
      layerExecutor,
      signal,
      deadline
    );
  }
  try {
    checkSignal(signal);
    return await (env.processInspector
      ? environmentScope(env.processInspector, signal, operation, deadline)
      : operation());
  } finally {
    Object.assign(env, original);
    env.probeExecutor = env.probeExecutor?.unscoped ?? probe;
    if (layerExecutor) {
      env.writableLayer.docker.executor = layerExecutor;
    }
  }
}

/** Scanner arrays emit completed findings immediately, retaining them on abort. */
export function scanItems(context) {
  const items = [];
  items.push = (...entries) => {
    for (const entry of entries) {
      context.emit?.(entry);
    }
    return Array.prototype.push.apply(items, entries);
  };
  return items;
}
