import assert from 'node:assert/strict';
import test from 'node:test';
import { getDeviceProfile } from './devices';
import { appendXorChecksum, buildTimeSyncBytes, resetUnreadRecordsCounter, type Logger } from './protocol';

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined };

test('appends an XOR checksum that makes the complete frame XOR to zero', () => {
  const packet = appendXorChecksum(Buffer.from([0x08, 0x01, 0x00, 0x02, 0x60, 0x04, 0x00]));
  assert.equal(packet.length, 8);
  assert.equal(packet.reduce((checksum, byte) => checksum ^ byte, 0), 0);
});

test('resets unread-record counters using each device byte order', () => {
  const littleEndian = Buffer.alloc(16);
  resetUnreadRecordsCounter(getDeviceProfile('hem-7155t'), littleEndian);
  assert.deepEqual([...littleEndian.subarray(4, 8)], [0x00, 0x80, 0x00, 0x80]);

  const bigEndian = Buffer.alloc(8);
  resetUnreadRecordsCounter(getDeviceProfile('hem-7322t'), bigEndian);
  assert.deepEqual([...bigEndian.subarray(4, 8)], [0x80, 0x00, 0x80, 0x00]);
});

test('builds settings time blocks for classic and compact models', () => {
  const now = new Date(2025, 5, 7, 8, 9, 10);
  const classic = getDeviceProfile('hem-7155t');
  const classicSettings = Buffer.alloc(classic.settingsWriteAddress! - classic.settingsReadAddress!);
  const classicRange = classic.timeSyncBytes!;
  Buffer.from([1, 2, 3, 4, 5, 6]).copy(classicSettings, classicRange.start + 8);
  const classicBlock = buildTimeSyncBytes(classic, classicSettings, now, silentLogger);
  assert.deepEqual([...classicBlock.subarray(8, 14)], [25, 6, 7, 8, 9, 10]);
  assert.equal(classicBlock[14], classicBlock.subarray(0, 14).reduce((sum, byte) => sum + byte, 0) & 0xff);
  assert.equal(classicBlock[15], 0);

  const compact = getDeviceProfile('hem-7322t');
  const compactSettings = Buffer.alloc(compact.settingsWriteAddress! - compact.settingsReadAddress!);
  const compactRange = compact.timeSyncBytes!;
  Buffer.from([6, 24, 7, 6, 5, 4]).copy(compactSettings, compactRange.start + 2);
  const compactBlock = buildTimeSyncBytes(compact, compactSettings, now, silentLogger);
  assert.deepEqual([...compactBlock.subarray(2, 8)], [6, 25, 8, 7, 10, 9]);
  assert.equal(compactBlock[8], 0);
  assert.equal(compactBlock[9], compactBlock.subarray(0, 9).reduce((sum, byte) => sum + byte, 0) & 0xff);
});

test('builds the BP5360 time block with its required byte and checksum', () => {
  const device = getDeviceProfile('hem-7377t1');
  const settings = Buffer.alloc(device.settingsWriteAddress! - device.settingsReadAddress!);
  const range = device.timeSyncBytes!;
  Buffer.from([1, 2, 3, 4, 0, 6, 7, 8, 24, 1, 2, 3, 4, 5]).copy(settings, range.start);
  const block = buildTimeSyncBytes(device, settings, new Date(2025, 5, 7, 8, 9, 10), silentLogger);
  assert.equal(block[4], 1);
  assert.deepEqual([...block.subarray(8, 14)], [25, 6, 7, 8, 9, 10]);
  assert.equal(block[14], block.subarray(0, 14).reduce((sum, byte) => sum + byte, 0) & 0xff);
  assert.equal(block[15], 0);
});
