/**
 * A trimmed `dss scan --json` report shown until the user pastes their own.
 */

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function item(rule, tier, bytes, path, extra = {}) {
  return {
    id: `host:${rule}:${path}`,
    env: 'host',
    envLabel: 'host (build-01)',
    kind: 'cache',
    ecosystem: rule.split('-')[0],
    rule,
    description: path,
    path,
    paths: [path],
    bytes: Math.round(bytes),
    tier,
    reason: '',
    blockers: [],
    requiresConfirmation: null,
    ...extra,
  };
}

const items = [
  item('bun-cache', 'safe', 2.3 * GiB, '~/.bun/install/cache'),
  item('cargo-superseded', 'safe', 1.8 * GiB, '/workspace/app/target/debug'),
  item('playwright-browsers', 'safe', 1.2 * GiB, '~/.cache/ms-playwright'),
  item('npm-cache', 'safe', 167 * MiB, '~/.npm/_cacache'),
  item('docker-build-cache', 'safe', 3.1 * GiB, 'Docker build cache'),
  item('node-modules', 'moderate', 612 * MiB, '~/old-project/node_modules'),
  item('cargo-target', 'aggressive', 4.4 * GiB, '/workspace/app/target'),
  item('docker-stopped-container', 'moderate', 19 * MiB, 'solver-7f3a', {
    blockers: ['Git repository /work/repo has 1 unpushed commit'],
  }),
];

export const sampleReport = {
  schema: 1,
  tool: 'disk-space-saviour',
  createdAt: '2026-09-25T12:00:00.000Z',
  environments: [{ id: 'host', label: 'host (build-01)', depth: 0 }],
  items,
};
