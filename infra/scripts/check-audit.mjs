#!/usr/bin/env node
// Gate for CI: fail on any high/critical npm audit finding, *unless* every
// affected install path sits inside aws-cdk-lib's own bundled dependency
// tree (node_modules/aws-cdk-lib/node_modules/...). aws-cdk-lib vendors
// minimatch (and its own nested brace-expansion) as a bundleDependency —
// shipped as literal files in its published tarball, not resolved through
// npm's normal dependency graph — so neither `npm audit fix` nor a root
// `overrides` entry can touch it. Only a new aws-cdk-lib release can. See
// https://github.com/aws/aws-cdk/issues (search "brace-expansion") for the
// recurring upstream pattern. Everything else still fails the build as
// before.
import { spawnSync } from 'node:child_process';

const AUDIT_LEVELS = new Set(['high', 'critical']);
const EXEMPT_PATH_PREFIX = 'node_modules/aws-cdk-lib/node_modules/';

const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', shell: true });

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('Could not parse `npm audit --json` output:');
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(1);
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
const blocking = [];
const exempted = [];

for (const vuln of vulnerabilities) {
  if (!AUDIT_LEVELS.has(vuln.severity)) continue;

  const nodes = vuln.nodes ?? [];
  const allBundledInCdk = nodes.length > 0 && nodes.every((n) => n.startsWith(EXEMPT_PATH_PREFIX));

  if (allBundledInCdk) {
    exempted.push(vuln);
  } else {
    blocking.push(vuln);
  }
}

for (const vuln of exempted) {
  console.log(`[exempted — bundled in aws-cdk-lib] ${vuln.name} (${vuln.severity}): ${vuln.nodes.join(', ')}`);
}

if (blocking.length > 0) {
  console.error('\nHigh/critical npm audit findings outside aws-cdk-lib\'s bundled deps:');
  for (const vuln of blocking) {
    console.error(`  ${vuln.name} (${vuln.severity}): ${(vuln.nodes ?? []).join(', ')}`);
  }
  console.error('\nRun `npm audit` for full details.');
  process.exit(1);
}

console.log('\nnpm audit: no high/critical findings outside aws-cdk-lib\'s bundled deps.');
