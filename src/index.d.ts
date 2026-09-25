/**
 * Type declarations for disk-space-saviour.
 */

export type Tier = 'safe' | 'moderate' | 'aggressive';
export type Size = number | string;
export type Duration = number | string;

export interface ScanOptions {
  /** Directories to search for projects (default: homes and tmp dirs). */
  roots?: string[] | string | null;
  /** Directory depth for project search. */
  maxDepth?: number;
  /** Activity window: newer files are kept (`1h`). */
  staleAge?: Duration;
  /** Alias of `staleAge`. */
  olderThan?: Duration;
  /** Inactivity before whole dependency dirs become `moderate` (`30d`). */
  inactive?: Duration;
  /** Items smaller than this are dropped (`1M`). */
  minSize?: Size;
  /** Scan the host file system (`false` for Docker only). */
  host?: boolean;
  /** `true` requires Docker, `false` skips it, `null` uses it if reachable. */
  docker?: boolean | null;
  /** Docker nesting depth (1 = containers of the host daemon). */
  dockerDepth?: number;
  /** Container ids or names to limit Docker work to. */
  containers?: string[] | string;
  scanners?: Array<'projects' | 'global' | 'versions' | 'agents' | 'system'>;
  /** Only these ecosystems, rules or kinds. */
  only?: string[] | string;
  /** Paths or basename globs never touched. */
  exclude?: string[] | string;
  includeVolumes?: boolean;
  removeStoppedContainers?: boolean;
  removeUnusedImages?: boolean;
  allowDirtyRepos?: boolean;
  /** Delete files directly, never through native cache commands. */
  noNative?: boolean;
  /** journald size to keep (`512M`). */
  journalKeep?: Size;
  backupDir?: string | null;
  auditDir?: string | null;
}

export interface CleanOptions extends ScanOptions {
  tier?: Tier;
  dryRun?: boolean;
  /** Interactive confirmation for items that need it. */
  confirm?: (item: Item) => boolean | Promise<boolean>;
  /** `false` skips writing the audit log file. */
  audit?: boolean;
  onEntry?: (entry: AuditEntry, item: Item) => void;
}

export interface EmergencyOptions extends CleanOptions {
  /** Available bytes wanted, e.g. `20G`. */
  free?: Size;
  /** Maximum used percentage, e.g. `80%`. */
  until?: number | string;
  /** Volume to watch (default `/`). */
  path?: string;
  /** Reuse an existing scan. */
  report?: Report;
}

export interface Action {
  type: 'remove' | 'command' | 'docker-rm' | 'none';
  paths?: string[];
  argv?: string[];
  containerId?: string;
  name?: string;
  [key: string]: unknown;
}

export interface Item {
  id: string;
  env: string;
  envLabel: string;
  kind: string;
  ecosystem: string;
  rule: string;
  description: string;
  path: string | null;
  paths: string[];
  bytes: number;
  newestMtimeMs: number;
  tier: Tier;
  reason: string;
  blockers: string[];
  requiresConfirmation: string | null;
  parentId: string | null;
  action: Action;
  [key: string]: unknown;
}

export interface Disk {
  total?: number;
  free: number;
  used: number;
  path?: string;
}

export interface EnvironmentDescriptor {
  id: string;
  label: string;
  kind: 'host' | 'container';
  depth: number;
  chain: Array<{ containerId: string; name: string }>;
  disk?: Disk | null;
}

export interface TierTotal {
  items: number;
  bytes: number;
}

export interface Report {
  schema: number;
  tool: 'disk-space-saviour';
  createdAt: string;
  durationMs: number;
  host: { env: string; label: string; platform: string };
  options: Record<string, unknown>;
  environments: EnvironmentDescriptor[];
  items: Item[];
  totals: Record<Tier | 'blocked', TierTotal>;
  docker: {
    daemons: Array<Record<string, unknown>>;
    containers: Array<Record<string, unknown>>;
    hints: Array<Record<string, unknown>>;
  } | null;
  errors: Array<{ env: string; scanner: string; message: string }>;
}

export interface AuditEntry {
  id: string;
  env: string;
  envLabel: string;
  rule: string;
  tier: Tier;
  kind: string;
  description: string;
  path: string | null;
  status: 'planned' | 'removed' | 'skipped' | 'failed';
  reason: string | null;
  plannedBytes: number;
  freedBytes: number;
  durationMs: number;
  backup?: string;
  [key: string]: unknown;
}

export interface EnvironmentTotal {
  label: string;
  freedBytes: number;
  leftBytes: number;
  removed: number;
  planned: number;
  skipped: number;
  failed: number;
}

export interface AuditLog {
  schema: number;
  tool: 'disk-space-saviour';
  command: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  entries: AuditEntry[];
  freedBytes: number;
  plannedBytes: number;
  environments: Record<string, EnvironmentTotal>;
  file?: string;
  goal?: { freeBytes: number | null; untilPercent: number | null };
  goalMet?: boolean;
  reachedTier?: Tier;
  diskBefore?: Disk;
  diskAfter?: Disk;
  [key: string]: unknown;
}

export declare const TIERS: Tier[];

/** Finds reclaimable space. Never deletes. */
export declare function scan(options?: ScanOptions): Promise<Report>;

/** Deletes what `options.tier` allows, re-checking every item first. */
export declare function clean(
  report: Report,
  options?: CleanOptions
): Promise<AuditLog>;

/** Escalates tiers until the free-space goal is met, then stops. */
export declare function emergency(options: EmergencyOptions): Promise<AuditLog>;

export declare function formatReport(
  report: Report,
  options?: { verbose?: boolean }
): string;
export declare function formatAudit(
  audit: AuditLog,
  options?: { verbose?: boolean }
): string;

/** Runs the `dss` command line and resolves to its exit code. */
export declare function runCli(
  argv: string[],
  deps?: { io?: object; api?: object }
): Promise<number>;

export declare function parseSize(value: string | number): number;
export declare function parseDuration(value: string | number): number;
export declare function parsePercent(value: string | number): number;
export declare function formatBytes(bytes: number): string;
export declare function formatDuration(ms: number): string;
export declare function goalMet(
  goal: { freeBytes: number | null; untilPercent: number | null },
  disk: Disk
): boolean;
export declare function selectByTier(items: Item[], tier: Tier): Item[];
export declare function dropNested(items: Item[]): Item[];
