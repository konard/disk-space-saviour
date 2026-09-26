/**
 * Rebuilds environment adapters from report descriptors, so a JSON report
 * written by `dss scan --json` can be cleaned later: an empty chain is the
 * host, every chain link is one `docker exec` hop.
 */

import { containerExecutor, hostExecutor } from '../exec.js';
import { LocalEnv } from './local.js';
import { ShellEnv } from './shell.js';

/**
 * @param {{id: string, label?: string, chain?: object[]}} descriptor
 * @param {{env?: object}} [options] `env` overrides the host adapter
 * @returns {{env: object, executor: object}}
 */
export function resolveEnvironment(descriptor, options = {}) {
  const chain = descriptor.chain ?? [];
  if (chain.length === 0) {
    const env = options.env ?? new LocalEnv();
    return { env, executor: env.executor ?? hostExecutor() };
  }
  const base = options.env?.executor ?? hostExecutor();
  const executor = chain.reduce(
    (parent, link) =>
      containerExecutor(parent, link.containerId, {
        label: `${parent.label}/${link.name}`,
      }),
    base
  );
  const env = new ShellEnv(executor, {
    id: descriptor.id,
    label: descriptor.label ?? executor.label,
    kind: 'container',
  });
  return { env, executor };
}
