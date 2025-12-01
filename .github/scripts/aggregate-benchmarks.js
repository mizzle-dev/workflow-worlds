#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
let resultsDir = '.';
let baselineDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline' && args[i + 1]) {
    baselineDir = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    resultsDir = args[i];
  }
}

// World display config
// Include all worlds from Workflow repo plus add worlds in this repo
const worldConfig = {
  local: { emoji: '💻', label: 'Local' },
  postgres: { emoji: '🐘', label: 'Postgres' },
  vercel: { emoji: '▲', label: 'Vercel' },
  starter: { emoji: '💾', label: 'Starter (in-memory)' },
  mongodb: { emoji: '🍃', label: 'MongoDB' },
  redis: { emoji: '🔴', label: 'Redis' },
};

// Format milliseconds as seconds
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
}

// Format delta between current and baseline values
// Returns string like "+12.3%" (slower) or "-5.2%" (faster) or "" if no baseline
function formatDelta(current, baseline) {
  if (
    baseline === null ||
    baseline === undefined ||
    current === null ||
    current === undefined
  ) {
    return '';
  }
  const percentChange = ((current - baseline) / baseline) * 100;
  if (Math.abs(percentChange) < 0.5) {
    return ' (~)';
  }
  const sign = percentChange > 0 ? '+' : '';
  const emoji = percentChange > 5 ? ' 🔺' : percentChange < -5 ? ' 🟢' : '';
  return ` (${sign}${percentChange.toFixed(1)}%${emoji})`;
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
// Format: bench-results-{world}.json
function parseFilename(filename) {
  const match = filename.match(/bench-results-(\w+)\.json$/);
  if (!match) return null;
  return { world: match[1] };
}

// Load timing data for a benchmark file
function loadTimingData(benchmarkFile, world) {
  // Try multiple possible locations for timing file
  const possiblePaths = [
    path.join(path.dirname(benchmarkFile), `bench-timings-${world}.json`),
    path.join(
      path.dirname(benchmarkFile),
      `workbench/bench-timings-${world}.json`
    ),
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
// Structure: { [benchmarkName]: { [world]: { wallTime, workflowTime, overhead, min, max, samples, firstByteTime } } }
function collectBenchmarkData(resultFiles) {
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
            let firstByteTimeMs = null;
            if (timings?.summary?.[benchName]) {
              workflowTimeMs = timings.summary[benchName].avgExecutionTimeMs;
              // Get TTFB for stream benchmarks
              if (timings.summary[benchName].avgFirstByteTimeMs !== undefined) {
                firstByteTimeMs = timings.summary[benchName].avgFirstByteTimeMs;
              }
            }

            data[benchName][world] = {
              wallTime: bench.mean,
              workflowTime: workflowTimeMs,
              overhead:
                workflowTimeMs !== null ? bench.mean - workflowTimeMs : null,
              min: bench.min,
              max: bench.max,
              samples: bench.sampleCount,
              firstByteTime: firstByteTimeMs,
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

// Get all worlds from the data in canonical order
function getWorlds(data) {
  const worlds = new Set();

  for (const benchData of Object.values(data)) {
    for (const world of Object.keys(benchData)) {
      worlds.add(world);
    }
  }

  // Sort: local, postgres, vercel, starter, mongodb, redis
  const worldOrder = ['local', 'postgres', 'vercel', 'starter', 'mongodb', 'redis'];
  return [...worlds].sort(
    (a, b) => worldOrder.indexOf(a) - worldOrder.indexOf(b)
  );
}

// Check if a benchmark has TTFB data (is a stream benchmark)
function isStreamBenchmark(benchData) {
  for (const metrics of Object.values(benchData)) {
    if (metrics.firstByteTime !== null) {
      return true;
    }
  }
  return false;
}

// Render a single benchmark table
function renderBenchmarkTable(benchName, benchData, baselineBenchData, worlds, isStream) {
  console.log(`## ${benchName}\n`);

  // Collect all data points
  const dataPoints = [];
  const validDataPoints = [];
  for (const world of worlds) {
    const metrics = benchData[world];
    const baseline = baselineBenchData?.[world] || null;
    const dataPoint = { world, metrics: metrics || null, baseline };
    dataPoints.push(dataPoint);
    if (metrics) {
      validDataPoints.push(dataPoint);
    }
  }

  if (validDataPoints.length === 0) {
    console.log('_No data available_\n');
    return;
  }

  // Sort valid data points by workflow time for ranking
  validDataPoints.sort((a, b) => {
    const aTime = a.metrics.workflowTime ?? a.metrics.wallTime;
    const bTime = b.metrics.workflowTime ?? b.metrics.wallTime;
    return aTime - bTime;
  });
  const fastest = validDataPoints[0];
  const fastestTime = fastest.metrics.workflowTime ?? fastest.metrics.wallTime;

  // Sort all data points: valid ones first (by time), then missing ones
  dataPoints.sort((a, b) => {
    if (!a.metrics && !b.metrics) return 0;
    if (!a.metrics) return 1;
    if (!b.metrics) return -1;
    const aTime = a.metrics.workflowTime ?? a.metrics.wallTime;
    const bTime = b.metrics.workflowTime ?? b.metrics.wallTime;
    return aTime - bTime;
  });

  // Render table - different columns for stream vs regular benchmarks
  if (isStream) {
    console.log(
      '| World | Workflow Time | TTFB | Wall Time | Overhead | vs Fastest |'
    );
    console.log(
      '|:------|--------------:|-----:|----------:|---------:|-----------:|'
    );
  } else {
    console.log(
      '| World | Workflow Time | Wall Time | Overhead | vs Fastest |'
    );
    console.log(
      '|:------|--------------:|----------:|---------:|-----------:|'
    );
  }

  for (const { world, metrics, baseline } of dataPoints) {
    const worldInfo = worldConfig[world] || { emoji: '', label: world };

    // Handle missing data
    if (!metrics) {
      if (isStream) {
        console.log(
          `| ${worldInfo.emoji} ${worldInfo.label} | ⚠️ _missing_ | - | - | - | - |`
        );
      } else {
        console.log(
          `| ${worldInfo.emoji} ${worldInfo.label} | ⚠️ _missing_ | - | - | - |`
        );
      }
      continue;
    }

    const isFastest = metrics === fastest.metrics;
    const medal = isFastest ? '🥇 ' : '';

    // Format workflow time with delta
    const workflowTimeSec =
      metrics.workflowTime !== null ? formatSec(metrics.workflowTime) : '-';
    const workflowDelta = formatDelta(
      metrics.workflowTime,
      baseline?.workflowTime
    );

    // Format wall time with delta
    const wallTimeSec = formatSec(metrics.wallTime);
    const wallDelta = formatDelta(metrics.wallTime, baseline?.wallTime);

    // Format overhead (no delta needed, it's derived)
    const overheadSec =
      metrics.overhead !== null ? formatSec(metrics.overhead) : '-';

    // Format TTFB with delta for stream benchmarks
    const firstByteSec =
      metrics.firstByteTime !== null ? formatSec(metrics.firstByteTime) : '-';
    const ttfbDelta = formatDelta(
      metrics.firstByteTime,
      baseline?.firstByteTime
    );

    const currentTime = metrics.workflowTime ?? metrics.wallTime;
    const factor = isFastest
      ? '1.00x'
      : `${(currentTime / fastestTime).toFixed(2)}x`;

    if (isStream) {
      console.log(
        `| ${medal}${worldInfo.emoji} ${worldInfo.label} | ${workflowTimeSec}s${workflowDelta} | ${firstByteSec}s${ttfbDelta} | ${wallTimeSec}s${wallDelta} | ${overheadSec}s | ${factor} |`
      );
    } else {
      console.log(
        `| ${medal}${worldInfo.emoji} ${worldInfo.label} | ${workflowTimeSec}s${workflowDelta} | ${wallTimeSec}s${wallDelta} | ${overheadSec}s | ${factor} |`
      );
    }
  }
  console.log('');
}

// Render the comparison tables
function renderComparison(data, baselineData) {
  const worlds = getWorlds(data);

  if (Object.keys(data).length === 0) {
    console.log('No benchmark data found.\n');
    return;
  }

  console.log('<!-- benchmark-results -->\n');
  console.log('# Benchmark Comparison\n');
  console.log(
    'Cross-comparison of workflow performance across World implementations.\n'
  );

  // Show baseline comparison note if baseline data is available
  if (baselineData && Object.keys(baselineData).length > 0) {
    console.log(
      '> 📈 _Comparing against baseline from `main` branch. Green 🟢 = faster, Red 🔺 = slower._\n'
    );
  }

  // Separate benchmarks into regular and stream categories
  const regularBenchmarks = [];
  const streamBenchmarks = [];

  for (const [benchName, benchData] of Object.entries(data)) {
    if (isStreamBenchmark(benchData)) {
      streamBenchmarks.push([benchName, benchData]);
    } else {
      regularBenchmarks.push([benchName, benchData]);
    }
  }

  // Render regular benchmarks first
  if (regularBenchmarks.length > 0) {
    for (const [benchName, benchData] of regularBenchmarks) {
      const baselineBenchData = baselineData?.[benchName] || null;
      renderBenchmarkTable(benchName, benchData, baselineBenchData, worlds, false);
    }
  }

  // Render stream benchmarks in a separate section
  if (streamBenchmarks.length > 0) {
    console.log('---\n');
    console.log('### Stream Benchmarks\n');
    console.log(
      '_Stream benchmarks include Time to First Byte (TTFB) metrics._\n'
    );

    for (const [benchName, benchData] of streamBenchmarks) {
      const baselineBenchData = baselineData?.[benchName] || null;
      renderBenchmarkTable(benchName, benchData, baselineBenchData, worlds, true);
    }
  }

  // Summary: Average Performance by World
  console.log('---\n');
  console.log('## Summary: Average Performance by World\n');
  console.log('| World | Avg Workflow Time | Benchmarks |');
  console.log('|:------|------------------:|-----------:|');

  const allBenchmarks = [...regularBenchmarks, ...streamBenchmarks];
  const worldTotals = {};
  const worldCounts = {};

  for (const [, benchData] of allBenchmarks) {
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
    '- **TTFB**: Time to First Byte - time from workflow start until first stream byte received (stream benchmarks only)'
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
  console.log('- 💻 Local: Built-in workflow world');
  console.log('- 🐘 Postgres: PostgreSQL database world');
  console.log('- ▲ Vercel: Vercel production world');
  console.log('- 💾 Starter: In-memory reference implementation');
  console.log('- 🍃 MongoDB: MongoDB database world');
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

// Load baseline data if provided
let baselineData = null;
if (baselineDir) {
  const baselineFiles = findBenchmarkFiles(baselineDir);
  if (baselineFiles.length > 0) {
    baselineData = collectBenchmarkData(baselineFiles);
  }
}

renderComparison(data, baselineData);
