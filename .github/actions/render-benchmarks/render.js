#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const [, , benchmarkFile, worldName] = process.argv;

if (!benchmarkFile || !worldName) {
  console.error('Usage: render.js <benchmark-file> <world-name>');
  process.exit(1);
}

// Try to load workflow timing data
let workflowTimings = null;
const timingFile = path.join(
  path.dirname(benchmarkFile),
  `workbench/bench-timings-${worldName}.json`
);
if (fs.existsSync(timingFile)) {
  try {
    workflowTimings = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
  } catch (e) {
    console.error(
      `Warning: Could not parse timing file ${timingFile}: ${e.message}`
    );
  }
}

// Format number with consistent width
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
}

// Get world emoji
function getWorldEmoji(world) {
  switch (world) {
    case 'default':
      return '📦';
    case 'starter':
      return '💾';
    case 'mongodb':
      return '🍃';
    case 'redis':
      return '🔴';
    default:
      return '';
  }
}

try {
  const data = JSON.parse(fs.readFileSync(benchmarkFile, 'utf-8'));

  const emoji = getWorldEmoji(worldName);
  console.log(`## ${emoji} Benchmark Results: ${worldName}\n`);

  for (const file of data.files) {
    for (const group of file.groups) {
      // Workflow Time is primary metric, Wall Time is secondary
      console.log(
        '| Benchmark | Workflow Time (avg) | Min | Max | Wall Time | Overhead | Samples |'
      );
      console.log(
        '|:----------|--------------------:|----:|----:|----------:|---------:|--------:|'
      );

      for (const bench of group.benchmarks) {
        // Skip benchmarks without valid timing data (failed or timed out)
        if (bench.mean === undefined || bench.mean === null) {
          console.log(`| ${bench.name} | No data | - | - | - | - | 0 |`);
          continue;
        }

        const wallTimeSec = formatSec(bench.mean);

        // Get workflow execution time if available
        let workflowTimeSec = '-';
        let minTimeSec = '-';
        let maxTimeSec = '-';
        let overheadSec = '-';

        if (workflowTimings?.summary?.[bench.name]) {
          const summary = workflowTimings.summary[bench.name];
          workflowTimeSec = formatSec(summary.avgExecutionTimeMs);

          // Get min/max if available
          if (summary.minExecutionTimeMs !== undefined) {
            minTimeSec = formatSec(summary.minExecutionTimeMs);
          }
          if (summary.maxExecutionTimeMs !== undefined) {
            maxTimeSec = formatSec(summary.maxExecutionTimeMs);
          }

          // Calculate overhead (wall time - workflow time)
          const overheadMs = bench.mean - summary.avgExecutionTimeMs;
          overheadSec = formatSec(overheadMs);
        }

        console.log(
          `| ${bench.name} | ${workflowTimeSec}s | ${minTimeSec}s | ${maxTimeSec}s | ${wallTimeSec}s | ${overheadSec}s | ${bench.sampleCount} |`
        );
      }
      console.log('');
    }
  }

  // Add legend
  console.log('<details>');
  console.log('<summary>Column Definitions</summary>\n');
  console.log(
    '- **Workflow Time (avg)**: Average runtime reported by workflow (completedAt - createdAt)'
  );
  console.log('- **Min**: Minimum workflow execution time across all samples');
  console.log('- **Max**: Maximum workflow execution time across all samples');
  console.log(
    '- **Wall Time**: Total testbench time (trigger workflow + poll for result)'
  );
  console.log('- **Overhead**: Testbench overhead (Wall Time - Workflow Time)');
  console.log('- **Samples**: Number of benchmark iterations run');
  console.log('</details>');
} catch (error) {
  console.error(`Error rendering benchmark results: ${error.message}`);
  process.exit(1);
}
