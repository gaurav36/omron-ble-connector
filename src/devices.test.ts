import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRingBufferReadLocations, deviceProfiles, getDeviceProfile, parseRecord } from './devices';

function setBits(bytes: Buffer, first: number, last: number, value: number, endianness: 'big' | 'little'): void {
  let current = 0n;
  if (endianness === 'big') {
    for (const byte of bytes) current = (current << 8n) | BigInt(byte);
  } else {
    for (let index = bytes.length - 1; index >= 0; index--) current = (current << 8n) | BigInt(bytes[index]);
  }
  const width = BigInt(last - first + 1);
  const shift = BigInt(bytes.length * 8 - last - 1);
  const mask = ((1n << width) - 1n) << shift;
  current = (current & ~mask) | (BigInt(value) << shift);
  for (let index = 0; index < bytes.length; index++) {
    const target = endianness === 'big' ? bytes.length - index - 1 : index;
    bytes[target] = Number((current >> BigInt(index * 8)) & 0xffn);
  }
}

test('decodes a 14-byte HEM-7322T measurement', () => {
  const device = getDeviceProfile('hem-7322t');
  const bytes = Buffer.alloc(14);
  setBits(bytes, 0, 7, 80, 'big');
  setBits(bytes, 8, 15, 95, 'big');
  setBits(bytes, 16, 23, 24, 'big');
  setBits(bytes, 24, 31, 72, 'big');
  setBits(bytes, 32, 32, 1, 'big');
  setBits(bytes, 33, 33, 0, 'big');
  setBits(bytes, 34, 37, 6, 'big');
  setBits(bytes, 38, 42, 18, 'big');
  setBits(bytes, 43, 47, 9, 'big');
  setBits(bytes, 52, 57, 41, 'big');
  setBits(bytes, 58, 63, 62, 'big');

  const record = parseRecord(device, bytes);
  assert.deepEqual(record, {
    datetime: new Date(2024, 5, 18, 9, 41, 59),
    dia: 80,
    sys: 120,
    bpm: 72,
    mov: 1,
    ihb: 0,
  });
});

test('decodes little-endian 16-byte records and clamps seconds', () => {
  const device = getDeviceProfile('hem-7150t');
  const bytes = Buffer.alloc(16);
  setBits(bytes, 68, 73, 30, 'little');
  setBits(bytes, 74, 79, 63, 'little');
  setBits(bytes, 82, 85, 12, 'little');
  setBits(bytes, 86, 90, 31, 'little');
  setBits(bytes, 91, 95, 23, 'little');
  setBits(bytes, 98, 103, 24, 'little');
  setBits(bytes, 104, 111, 70, 'little');
  setBits(bytes, 112, 119, 82, 'little');
  setBits(bytes, 120, 127, 95, 'little');

  const record = parseRecord(device, bytes);
  assert.equal(record.datetime.getTime(), new Date(2024, 11, 31, 23, 30, 59).getTime());
  assert.equal(record.sys, 120);
  assert.equal(record.dia, 82);
  assert.equal(record.bpm, 70);
});

test('decodes HEM-6232T six-bit year and swapped movement/IHB flags', () => {
  const device = getDeviceProfile('hem-6232t');
  const bytes = Buffer.alloc(14);
  setBits(bytes, 0, 7, 77, 'big');
  setBits(bytes, 8, 15, 90, 'big');
  setBits(bytes, 18, 23, 26, 'big');
  setBits(bytes, 24, 31, 68, 'big');
  setBits(bytes, 32, 32, 1, 'big');
  setBits(bytes, 33, 33, 0, 'big');
  setBits(bytes, 34, 37, 4, 'big');
  setBits(bytes, 38, 42, 9, 'big');
  setBits(bytes, 43, 47, 7, 'big');
  setBits(bytes, 52, 57, 12, 'big');
  setBits(bytes, 58, 63, 14, 'big');

  const record = parseRecord(device, bytes);
  assert.equal(record.datetime.getFullYear(), 2026);
  assert.equal(record.mov, 0);
  assert.equal(record.ihb, 1);
});

test('decodes BP5360 records and rejects invalid slots', () => {
  const device = getDeviceProfile('hem-7377t1');
  const bytes = Buffer.alloc(16);
  setBits(bytes, 68, 73, 45, 'little');
  setBits(bytes, 74, 79, 62, 'little');
  setBits(bytes, 80, 80, 1, 'little');
  setBits(bytes, 81, 81, 1, 'little');
  setBits(bytes, 82, 85, 7, 'little');
  setBits(bytes, 86, 90, 20, 'little');
  setBits(bytes, 91, 95, 10, 'little');
  setBits(bytes, 98, 103, 25, 'little');
  setBits(bytes, 104, 111, 70, 'little');
  setBits(bytes, 112, 119, 82, 'little');
  setBits(bytes, 120, 127, 95, 'little');

  const record = parseRecord(device, bytes);
  assert.equal(record.datetime.getTime(), new Date(2025, 6, 20, 10, 45, 59).getTime());
  assert.equal(record.sys, 120);
  assert.equal(record.mov, 1);
  assert.equal(record.ihb, 1);
  assert.throws(() => parseRecord(device, Buffer.alloc(16)), /record slot is empty/);
});

test('calculates wrapped and contiguous ring-buffer reads', () => {
  const device = getDeviceProfile('hem-7155t');
  assert.deepEqual(calculateRingBufferReadLocations(device, 0, 5, 3), [
    { address: 0x0098, size: 3 * 0x10 },
    { address: 0x0098 + 58 * 0x10, size: 2 * 0x10 },
  ]);
  assert.deepEqual(calculateRingBufferReadLocations(device, 1, 4, 10), [
    { address: 0x0458 + 6 * 0x10, size: 4 * 0x10 },
  ]);
});

test('rejects impossible calendar dates in records', () => {
  const device = getDeviceProfile('hem-7322t');
  const bytes = Buffer.alloc(14);
  setBits(bytes, 16, 23, 24, 'big');
  setBits(bytes, 34, 37, 2, 'big');
  setBits(bytes, 38, 42, 31, 'big');
  assert.throws(() => parseRecord(device, bytes), /Invalid date in record/);
});

test('registers each Omblepy-supported model with a complete memory layout', () => {
  assert.equal(deviceProfiles.length, 11);
  for (const device of deviceProfiles) {
    assert.equal(device.userStartAddresses.length, device.recordsPerUser.length, device.model);
    assert.ok(device.recordByteSize > 0, device.model);
    assert.ok(device.transmissionBlockSize > 0, device.model);
    for (const alias of device.aliases) {
      assert.equal(getDeviceProfile(alias), device);
    }
  }
});
