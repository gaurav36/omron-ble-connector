import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseBloodPressureCsv, parseCsv, saveRecords, toUbpmJson } from './storage';

test('parses exported Omblepy CSV rows', () => {
  const records = parseBloodPressureCsv(
    'datetime,dia,sys,bpm,mov,ihb\n2025-02-03 04:05:06,78,125,65,0,1\n',
  );
  assert.deepEqual(records, [{
    datetime: new Date(2025, 1, 3, 4, 5, 6),
    dia: 78,
    sys: 125,
    bpm: 65,
    mov: 0,
    ihb: 1,
  }]);
});

test('supports quoted commas, escaped quotes, and newlines in CSV fields', () => {
  assert.deepEqual(parseCsv('name,note\ncuff,"left, ""upper"" arm"\n'), [
    ['name', 'note'],
    ['cuff', 'left, "upper" arm'],
  ]);
});

test('maps records to the UBPM date/time format', () => {
  const record = {
    datetime: new Date(2025, 8, 7, 6, 5, 4),
    dia: 80,
    sys: 120,
    bpm: 70,
    mov: 0,
    ihb: 1,
  };
  assert.deepEqual(toUbpmJson([[record]]), {
    UBPM: {
      U1: [{
        date: '07.09.2025',
        time: '06:05:04',
        msg: '',
        sys: 120,
        dia: 80,
        bpm: 70,
        ihb: 1,
        mov: 0,
      }],
    },
  });
});

test('merges existing CSV history into both CSV and UBPM exports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omron-ble-connector-'));
  try {
    await writeFile(
      join(directory, 'user1.csv'),
      'datetime,dia,sys,bpm,mov,ihb\n2025-01-01 01:00:00,70,110,60,0,0\n',
    );
    await saveRecords([[
      {
        datetime: new Date(2025, 0, 2, 1, 0, 0),
        dia: 75,
        sys: 118,
        bpm: 62,
        mov: 0,
        ihb: 0,
      },
    ]], directory);
    const csv = await readFile(join(directory, 'user1.csv'), 'utf8');
    const json = JSON.parse(await readFile(join(directory, 'ubpm.json'), 'utf8')) as {
      UBPM: { U1: Array<{ date: string; sys: number }> };
    };
    assert.match(csv, /2025-01-01 01:00:00/);
    assert.match(csv, /2025-01-02 01:00:00/);
    assert.equal(json.UBPM.U1.length, 2);
    assert.equal(json.UBPM.U1[0].sys, 110);
    assert.equal(json.UBPM.U1[1].sys, 118);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
