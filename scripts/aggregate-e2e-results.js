#!/usr/bin/env node

// Aggregates vitest JSON results from e2e test runs and outputs a markdown summary.
// Usage: node aggregate-e2e-results.js <results-dir> [--run-url <url>]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let resultsDir = '.';
let runUrl = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run-url' && args[i + 1]) {
    runUrl = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    resultsDir = args[i];
  }
}

const worldNames = {
  turso: 'Turso',
  mongodb: 'MongoDB',
  redis: 'Redis',
  starter: 'Starter',
};

function findResultFiles(dir) {
  const files = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findResultFiles(fullPath));
      } else if (entry.name.startsWith('e2e-') && entry.name.endsWith('.json')) {
        files.push(fullPath);
      }
    }
  } catch {
    // skip
  }
  return files;
}

function parseResults(file) {
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const results = { file: path.basename(file), passed: 0, failed: 0, skipped: 0, duration: 0, failedTests: [] };

    if (content.testResults) {
      for (const suite of content.testResults) {
        results.duration += suite.duration || 0;
        for (const test of suite.assertionResults || []) {
          if (test.status === 'passed') results.passed++;
          else if (test.status === 'failed') {
            results.failed++;
            results.failedTests.push({
              name: test.fullName || test.title,
              message: test.failureMessages?.join('\n').slice(0, 300) || '',
            });
          } else if (test.status === 'skipped' || test.status === 'pending') {
            results.skipped++;
          }
        }
      }
    }
    return results;
  } catch (e) {
    console.error(`Warning: Could not parse ${file}: ${e.message}`);
    return null;
  }
}

function worldFromFilename(filename) {
  // e2e-turso.json -> turso, e2e-results-turso/e2e-turso.json -> turso
  const base = path.basename(filename, '.json');
  const match = base.match(/^e2e-(.+)$/);
  return match ? match[1] : base;
}

// Collect results
const files = findResultFiles(resultsDir);
const worlds = [];

for (const file of files) {
  const worldId = worldFromFilename(file);
  const results = parseResults(file);
  if (results) {
    worlds.push({ id: worldId, name: worldNames[worldId] || worldId, ...results });
  }
}

// Sort: failed worlds first, then alphabetical
worlds.sort((a, b) => (b.failed > 0 ? 1 : 0) - (a.failed > 0 ? 1 : 0) || a.name.localeCompare(b.name));

const totalPassed = worlds.reduce((s, w) => s + w.passed, 0);
const totalFailed = worlds.reduce((s, w) => s + w.failed, 0);
const totalSkipped = worlds.reduce((s, w) => s + w.skipped, 0);
const total = totalPassed + totalFailed + totalSkipped;
const allPassed = totalFailed === 0;

const lines = [];
const p = (s) => lines.push(s);

// Header
p('<!-- e2e-community-worlds -->');
p(`## ${allPassed ? '✅' : '❌'} E2E Test Results\n`);

if (worlds.length === 0) {
  p('_No test results found._\n');
  console.log(lines.join('\n'));
  process.exit(0);
}

// Summary table
p('| World | Passed | Failed | Skipped | Total | |');
p('|:------|-------:|-------:|--------:|------:|:--|');
for (const w of worlds) {
  const wTotal = w.passed + w.failed + w.skipped;
  const icon = w.failed > 0 ? '❌' : '✅';
  p(`| ${w.name} | ${w.passed} | ${w.failed} | ${w.skipped} | ${wTotal} | ${icon} |`);
}
p(`| **Total** | **${totalPassed}** | **${totalFailed}** | **${totalSkipped}** | **${total}** | |`);
p('');

// Failed tests
if (totalFailed > 0) {
  p('### Failed Tests\n');
  for (const w of worlds) {
    if (w.failedTests.length === 0) continue;
    p(`<details>`);
    p(`<summary><b>${w.name}</b> — ${w.failedTests.length} failed</summary>\n`);
    for (const t of w.failedTests) {
      const name = t.name.replace(/^e2e\s*>\s*/, '');
      p(`- \`${name}\``);
      if (t.message) {
        // Indent error under the bullet, truncated
        const short = t.message.split('\n')[0].slice(0, 120);
        p(`  > ${short}`);
      }
    }
    p('\n</details>\n');
  }
}

// Duration
const totalDuration = worlds.reduce((s, w) => s + w.duration, 0);
if (totalDuration > 0) {
  p(`_Total duration: ${(totalDuration / 1000).toFixed(1)}s_\n`);
}

// Run link
if (runUrl) {
  p(`[View workflow run](${runUrl})`);
}

const output = lines.join('\n');
console.log(output);

// Also write to file for PR comment
fs.writeFileSync(path.join(resultsDir, 'e2e-summary.md'), output);

process.exit(totalFailed > 0 ? 1 : 0);
