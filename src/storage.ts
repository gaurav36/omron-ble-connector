import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BloodPressureRecord } from './types';

const recordHeaders = ['datetime', 'dia', 'sys', 'bpm', 'mov', 'ihb'] as const;

export async function saveRecords(
  recordsByUser: readonly (readonly BloodPressureRecord[])[],
  directory = process.cwd(),
): Promise<void> {
  const mergedUsers: BloodPressureRecord[][] = [];
  for (let userIndex = 0; userIndex < recordsByUser.length; userIndex++) {
    const filePath = join(directory, `user${userIndex + 1}.csv`);
    const newRecords = [...recordsByUser[userIndex]];
    let combined = newRecords;
    try {
      const oldCsv = await readFile(filePath, 'utf8');
      const timestamp = formatBackupTimestamp(new Date());
      await copyFile(filePath, join(directory, `backup_user${userIndex + 1}_${timestamp}.csv`));
      const oldRecords = parseBloodPressureCsv(oldCsv);
      const newDates = new Set(newRecords.map((record) => formatDateTime(record.datetime)));
      combined = [...newRecords, ...oldRecords.filter((record) => !newDates.has(formatDateTime(record.datetime)))];
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    combined.sort((left, right) => left.datetime.getTime() - right.datetime.getTime());
    mergedUsers.push(combined);
    const lines = [recordHeaders.join(',')];
    for (const record of combined) {
      lines.push([
        formatDateTime(record.datetime),
        record.dia,
        record.sys,
        record.bpm,
        record.mov,
        record.ihb,
      ].join(','));
    }
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  }
  await writeFile(join(directory, 'ubpm.json'), `${JSON.stringify(toUbpmJson(mergedUsers), null, 4)}\n`, 'utf8');
}

export function parseBloodPressureCsv(csv: string): BloodPressureRecord[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0];
  const columnIndexes = Object.fromEntries(recordHeaders.map((name) => [name, header.indexOf(name)]));
  for (const name of recordHeaders) {
    if (columnIndexes[name] === -1) throw new Error(`CSV is missing required column "${name}"`);
  }

  return rows.slice(1).filter((row) => row.some((field) => field.trim() !== '')).map((row, rowIndex) => {
    const datetime = parseDateTime(row[columnIndexes.datetime], rowIndex + 2);
    return {
      datetime,
      dia: parseNumber(row[columnIndexes.dia], 'dia', rowIndex + 2),
      sys: parseNumber(row[columnIndexes.sys], 'sys', rowIndex + 2),
      bpm: parseNumber(row[columnIndexes.bpm], 'bpm', rowIndex + 2),
      mov: parseNumber(row[columnIndexes.mov], 'mov', rowIndex + 2),
      ihb: parseNumber(row[columnIndexes.ihb], 'ihb', rowIndex + 2),
    };
  });
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

export function formatDateTime(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function toUbpmJson(recordsByUser: readonly (readonly BloodPressureRecord[])[]): {
  UBPM: Record<string, Array<Record<string, number | string>>>;
} {
  const users: Record<string, Array<Record<string, number | string>>> = {};
  recordsByUser.forEach((records, index) => {
    users[`U${index + 1}`] = records.map((record) => ({
      date: `${record.datetime.getDate().toString().padStart(2, '0')}.${(record.datetime.getMonth() + 1).toString().padStart(2, '0')}.${record.datetime.getFullYear()}`,
      time: `${record.datetime.getHours().toString().padStart(2, '0')}:${record.datetime.getMinutes().toString().padStart(2, '0')}:${record.datetime.getSeconds().toString().padStart(2, '0')}`,
      msg: '',
      sys: record.sys,
      dia: record.dia,
      bpm: record.bpm,
      ihb: record.ihb,
      mov: record.mov,
    }));
  });
  return { UBPM: users };
}

export async function loadPlotCsv(path: string): Promise<BloodPressureRecord[]> {
  const contents = await readFile(path, 'utf8');
  if (!contents.trim()) throw new Error(`Input CSV is empty: ${basename(path)}`);
  return parseBloodPressureCsv(contents);
}

function parseDateTime(value: string | undefined, rowNumber: number): Date {
  if (!value) throw new Error(`CSV row ${rowNumber} has no datetime`);
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid datetime on CSV row ${rowNumber}: ${value}`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    throw new Error(`Invalid datetime on CSV row ${rowNumber}: ${value}`);
  }
  return date;
}

function parseNumber(value: string | undefined, field: string, rowNumber: number): number {
  const number = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(number)) {
    throw new Error(`Invalid ${field} value on CSV row ${rowNumber}`);
  }
  return number;
}

function formatBackupTimestamp(date: Date): string {
  return `${date.getFullYear()}_${(date.getMonth() + 1).toString().padStart(2, '0')}_${date.getDate().toString().padStart(2, '0')}__${date.getHours().toString().padStart(2, '0')}_${date.getMinutes().toString().padStart(2, '0')}_${date.getSeconds().toString().padStart(2, '0')}`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
