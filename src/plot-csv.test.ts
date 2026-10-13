import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { averageValues, createPlot } from './plot-csv';
import type { BloodPressureRecord } from './types';

const records: BloodPressureRecord[] = [
  { datetime: new Date(2025, 0, 1, 8), dia: 70, sys: 110, bpm: 60, mov: 0, ihb: 0 },
  { datetime: new Date(2025, 0, 2, 8), dia: 80, sys: 130, bpm: 65, mov: 0, ihb: 0 },
  { datetime: new Date(2025, 0, 3, 8), dia: 90, sys: 150, bpm: 70, mov: 0, ihb: 1 },
];

test('averages readings into consecutive day bins', () => {
  const averages = averageValues(records, 2);
  assert.deepEqual(averages, [
    { date: '2025-01-01', systolic: 120, diastolic: 75 },
    { date: '2025-01-03', systolic: 150, diastolic: 90 },
  ]);
});

test('creates a browser chart from exported CSV data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omron-ble-plot-'));
  const inputPath = join(directory, 'records.csv');
  const outputPath = join(directory, 'chart.html');
  try {
    await writeFile(
      inputPath,
      'datetime,dia,sys,bpm,mov,ihb\n2025-01-01 08:00:00,70,110,60,0,0\n',
    );
    assert.equal(await createPlot(inputPath, { windowDays: 7, binDays: 1, outputPath }), outputPath);
    const html = await readFile(outputPath, 'utf8');
    assert.match(html, /role="img"/);
    assert.match(html, /type="range"/);
    assert.match(html, /2025-01-01/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
