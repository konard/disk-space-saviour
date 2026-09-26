import { createElement as h, useMemo, useState } from 'react';
import { TIERS, tierTotals } from '../../../src/items.js';
import { formatBytes } from '../../../src/units.js';
import { sampleReport } from './sample-report.js';

const repositoryUrl =
  import.meta.env.VITE_REPOSITORY_URL ??
  'https://github.com/konard/disk-space-saviour';

const TONES = {
  safe: 'green',
  moderate: 'blue',
  aggressive: 'amber',
  blocked: 'grey',
};

const commands = [
  {
    label: 'Report',
    detail: 'npx disk-space-saviour scan --json > report.json',
  },
  {
    label: 'Clean caches',
    detail: 'dss clean --tier safe --yes',
  },
  {
    label: 'Emergency',
    detail: 'dss emergency --free 20G --yes',
  },
];

/**
 * Parses pasted `dss scan --json` output; falls back to the sample.
 */
export function readReport(text) {
  if (text.trim() === '') {
    return { report: sampleReport, error: null };
  }
  try {
    const report = JSON.parse(text);
    if (!Array.isArray(report.items)) {
      return { report: sampleReport, error: 'No items array in this JSON.' };
    }
    return { report, error: null };
  } catch (error) {
    return { report: sampleReport, error: error.message };
  }
}

function ResultTile({ label, value, tone }) {
  return h(
    'div',
    { className: `result-tile result-tile-${tone}` },
    h('span', { className: 'result-label' }, label),
    h('strong', null, value)
  );
}

function ItemRow({ item }) {
  const blocked = item.blockers.length > 0;
  return h(
    'li',
    null,
    h('span', null, `${formatBytes(item.bytes)} · ${item.rule}`),
    h(
      'small',
      null,
      blocked
        ? `kept: ${item.blockers[0]}`
        : `${item.tier}: ${item.path ?? item.description}`
    )
  );
}

function CommandRow({ label, detail }) {
  return h('li', null, h('span', null, label), h('code', null, detail));
}

export function App() {
  const [text, setText] = useState('');
  const { report, error } = useMemo(() => readReport(text), [text]);
  const totals = useMemo(() => tierTotals(report.items), [report]);
  const largest = useMemo(
    () => [...report.items].sort((a, b) => b.bytes - a.bytes).slice(0, 6),
    [report]
  );

  return h(
    'main',
    { className: 'app-shell' },
    h(
      'section',
      { className: 'workspace', 'aria-labelledby': 'report-title' },
      h(
        'div',
        { className: 'calculator-panel' },
        h('p', { className: 'eyebrow' }, 'Scan report viewer'),
        h('h1', { id: 'report-title' }, 'Reclaimable disk space'),
        h(
          'label',
          { className: 'number-field report-field', htmlFor: 'report-json' },
          h('span', null, 'Paste `dss scan --json` output (sample shown)'),
          h('textarea', {
            id: 'report-json',
            rows: 3,
            value: text,
            placeholder: '{"schema": 1, "items": [...]}',
            onChange: (event) => setText(event.target.value),
          })
        ),
        error ? h('p', { className: 'report-error' }, error) : null,
        h(
          'div',
          { className: 'results-grid', 'aria-live': 'polite' },
          [...TIERS, 'blocked'].map((tier) =>
            h(ResultTile, {
              key: tier,
              label: tier === 'blocked' ? 'Blocked (kept)' : `Up to ${tier}`,
              value: formatBytes(totals[tier].bytes),
              tone: TONES[tier],
            })
          )
        ),
        h(
          'ul',
          { className: 'target-list' },
          largest.map((item) => h(ItemRow, { key: item.id, item }))
        )
      ),
      h(
        'aside',
        {
          className: 'distribution-panel',
          'aria-labelledby': 'commands-title',
        },
        h('h2', { id: 'commands-title' }, 'Run it'),
        h(
          'p',
          null,
          'Scans never delete. Cleaning re-checks liveness and Git state before every item.'
        ),
        h(
          'ul',
          { className: 'target-list' },
          commands.map((command) =>
            h(CommandRow, { key: command.label, ...command })
          )
        ),
        h(
          'a',
          {
            className: 'download-link',
            href: repositoryUrl,
            target: '_blank',
            rel: 'noreferrer',
          },
          'Open the repository'
        )
      )
    )
  );
}
