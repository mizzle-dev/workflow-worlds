#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const [, , resultsDir = '.'] = process.argv;

// World display config
const worldConfig = {
  default: { emoji: '📦', label: 'Default (built-in)' },
  starter: { emoji: '💾', label: 'Starter (in-memory)' },
  mongodb: { emoji: '🍃', label: 'MongoDB' },
  postgres: { emoji: '🐘', label: 'PostgreSQL' },
  redis: { emoji: '🔴', label: 'Redis' },
};

// Format milliseconds as seconds
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
}

// Find all benchmark result files
function findBenchmarkFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findBenchmarkFiles(fullPath));
      } else if (
        entry.name.startsWith('bench-results-') &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    console.error(`Warning: Could not read directory ${dir}: ${e.message}`);
  }
  return files;
}

// Parse filename to extract world name
function parseFilename(filename) {
  // Format: bench-results-{world}.json
  const match = filename.match(/bench-results-(\w+)\.json$/);
  if (!match) return null;
  return { world: match[1] };
}

// Load timing data for a benchmark file
function loadTimingData(benchmarkFile, world) {
  // Try multiple possible locations for timing file
  const possiblePaths = [
    path.join(path.dirname(benchmarkFile), `bench-timings-${world}.json`),
    path.join(path.dirname(benchmarkFile), `workbench/bench-timings-${world}.json`),
  ];

  for (const timingFile of possiblePaths) {
    if (fs.existsSync(timingFile)) {
      try {
        return JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
      } catch (e) {
        console.error(
          `Warning: Could not parse timing file ${timingFile}: ${e.message}`
        );
      }
    }
  }
  return null;
}

// Collect all benchmark data
function collectBenchmarkData(resultFiles) {
  // Structure: { [benchmarkName]: { [world]: { wallTime, workflowTime, overhead, min, max, samples } } }
  const data = {};

  for (const file of resultFiles) {
    const parsed = parseFilename(path.basename(file));
    if (!parsed) continue;

    const { world } = parsed;

    try {
      const results = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const timings = loadTimingData(file, world);

      for (const fileData of results.files || []) {
        for (const group of fileData.groups || []) {
          for (const bench of group.benchmarks || []) {
            // Skip benchmarks without valid timing data (failed or timed out)
            if (bench.mean === undefined || bench.mean === null) {
              continue;
            }

            const benchName = bench.name;

            if (!data[benchName]) {
              data[benchName] = {};
            }

            // Get workflow timing if available
            let workflowTimeMs = null;
            if (timings?.summary?.[benchName]) {
              workflowTimeMs = timings.summary[benchName].avgExecutionTimeMs;
            }

            data[benchName][world] = {
              wallTime: bench.mean,
              workflowTime: workflowTimeMs,
              overhead:
                workflowTimeMs !== null ? bench.mean - workflowTimeMs : null,
              min: bench.min,
              max: bench.max,
              samples: bench.sampleCount,
            };
          }
        }
      }
    } catch (e) {
      console.error(
        `Warning: Could not parse benchmark file ${file}: ${e.message}`
      );
    }
  }

  return data;
}

// Get all worlds from the data
function getWorlds(data) {
  const worlds = new Set();

  for (const benchData of Object.values(data)) {
    for (const world of Object.keys(benchData)) {
      worlds.add(world);
    }
  }

  // Sort: default, starter, mongodb, postgres, redis
  const worldOrder = ['default', 'starter', 'mongodb', 'postgres', 'redis'];
  return [...worlds].sort(
    (a, b) => worldOrder.indexOf(a) - worldOrder.indexOf(b)
  );
}

// Render the comparison tables
function renderComparison(data) {
  const worlds = getWorlds(data);

  if (Object.keys(data).length === 0) {
    console.log('No benchmark data found.\n');
    return;
  }

  console.log('# Benchmark Comparison\n');
  console.log(
    'Cross-comparison of workflow performance across World implementations.\n'
  );

  // For each benchmark, create a comparison table
  for (const [benchName, benchData] of Object.entries(data)) {
    console.log(`## ${benchName}\n`);

    // Collect all data points with their wall times for ranking
    const dataPoints = [];
    for (const world of worlds) {
      const metrics = benchData[world];
      if (metrics) {
        dataPoints.push({ world, metrics });
      }
    }

    if (dataPoints.length === 0) {
      console.log('_No data available_\n');
      continue;
    }

    // Sort by workflow time (primary metric), fall back to wall time if workflow time unavailable
    dataPoints.sort((a, b) => {
      const aTime = a.metrics.workflowTime ?? a.metrics.wallTime;
      const bTime = b.metrics.workflowTime ?? b.metrics.wallTime;
      return aTime - bTime;
    });
    const fastest = dataPoints[0];
    const fastestTime =
      fastest.metrics.workflowTime ?? fastest.metrics.wallTime;

    // Render table - Workflow Time is primary metric
    console.log(
      '| World | Workflow Time | Wall Time | Overhead | vs Fastest |'
    );
    console.log(
      '|:------|--------------:|----------:|---------:|-----------:|'
    );

    for (const { world, metrics } of dataPoints) {
      const worldInfo = worldConfig[world] || {
        emoji: '',
        label: world,
      };

      const isFastest = metrics === fastest.metrics;
      const medal = isFastest ? ' (fastest)' : '';

      const workflowTimeSec =
        metrics.workflowTime !== null ? formatSec(metrics.workflowTime) : '-';
      const wallTimeSec = formatSec(metrics.wallTime);
      const overheadSec =
        metrics.overhead !== null ? formatSec(metrics.overhead) : '-';

      const currentTime = metrics.workflowTime ?? metrics.wallTime;
      const factor = isFastest
        ? '1.00x'
        : `${(currentTime / fastestTime).toFixed(2)}x`;

      console.log(
        `| ${worldInfo.emoji} ${worldInfo.label}${medal} | ${workflowTimeSec}s | ${wallTimeSec}s | ${overheadSec}s | ${factor} |`
      );
    }
    console.log('');
  }

  // Summary: Best world overall (by average Workflow Time)
  console.log('## Summary: Average Performance by World\n');
  console.log('| World | Avg Workflow Time | Benchmarks |');
  console.log('|:------|------------------:|-----------:|');

  const worldTotals = {};
  const worldCounts = {};

  for (const benchData of Object.values(data)) {
    for (const [world, metrics] of Object.entries(benchData)) {
      const time = metrics.workflowTime ?? metrics.wallTime;
      worldTotals[world] = (worldTotals[world] || 0) + time;
      worldCounts[world] = (worldCounts[world] || 0) + 1;
    }
  }

  // Sort by average time
  const worldAverages = worlds
    .filter((world) => worldCounts[world] > 0)
    .map((world) => ({
      world,
      avgTime: worldTotals[world] / worldCounts[world],
      count: worldCounts[world],
    }))
    .sort((a, b) => a.avgTime - b.avgTime);

  for (const { world, avgTime, count } of worldAverages) {
    const worldInfo = worldConfig[world] || { emoji: '', label: world };
    console.log(
      `| ${worldInfo.emoji} ${worldInfo.label} | ${formatSec(avgTime)}s | ${count} |`
    );
  }
  console.log('');

  // Legend
  console.log('<details>');
  console.log('<summary>Column Definitions</summary>\n');
  console.log(
    '- **Workflow Time**: Runtime reported by workflow (completedAt - createdAt) - *primary metric*'
  );
  console.log(
    '- **Wall Time**: Total testbench time (trigger workflow + poll for result)'
  );
  console.log('- **Overhead**: Testbench overhead (Wall Time - Workflow Time)');
  console.log(
    '- **vs Fastest**: How much slower compared to the fastest World for this benchmark'
  );
  console.log('');
  console.log('**Worlds:**');
  console.log('- 📦 Default: Built-in workflow world');
  console.log('- 💾 Starter: In-memory reference implementation');
  console.log('- 🍃 MongoDB: MongoDB database backend');
  console.log('- 🐘 PostgreSQL: PostgreSQL database backend');
  console.log('- 🔴 Redis: Redis/BullMQ backend');
  console.log('</details>');
}

// Main
const resultFiles = findBenchmarkFiles(resultsDir);

if (resultFiles.length === 0) {
  console.log('No benchmark result files found in', resultsDir);
  process.exit(0);
}

const data = collectBenchmarkData(resultFiles);
renderComparison(data);
