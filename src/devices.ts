import type { BloodPressureRecord, ByteRange, DeviceProfile, ReadCommand } from './types';

const legacyService = 'ecbe3980-c9a2-11e1-b1bd-0002a5d5c51b';
const legacyRx = [
  '49123040-aee8-11e1-a74d-0002a5d5c51b',
  '4d0bf320-aee8-11e1-a0d9-0002a5d5c51b',
  '5128ce60-aee8-11e1-b84b-0002a5d5c51b',
  '560f1420-aee8-11e1-8184-0002a5d5c51b',
] as const;
const legacyTx = [
  'db5b55e0-aee7-11e1-965e-0002a5d5c51b',
  'e0b8a060-aee7-11e1-92f4-0002a5d5c51b',
  '0ae12b00-aee8-11e1-a192-0002a5d5c51b',
  '10e1ba60-aee8-11e1-89e5-0002a5d5c51b',
] as const;
const unlockUuid = 'b305b680-aee7-11e1-a730-0002a5d5c51b';
const modernService = '0000fe4a-0000-1000-8000-00805f9b34fb';
const modernRx = ['49123040-aee8-11e1-a74d-0002a5d5c51b'] as const;
const modernTx = ['db5b55e0-aee7-11e1-965e-0002a5d5c51b'] as const;

interface ProfileOptions {
  model: string;
  aliases: readonly string[];
  userStartAddresses: readonly number[];
  recordsPerUser: readonly number[];
  recordByteSize: number;
  transmissionBlockSize: number;
  endianness: 'big' | 'little';
  recordFormat: DeviceProfile['recordFormat'];
  compactYearStartBit?: 16 | 18;
  settingsReadAddress: number | null;
  settingsWriteAddress: number | null;
  unreadRecordsBytes: ByteRange | null;
  timeSyncBytes: ByteRange | null;
  timeSyncFormat: DeviceProfile['timeSyncFormat'];
  modernService?: boolean;
  requiresUnlock?: boolean;
  supportsPairing?: boolean;
  supportsOsBondingOnly?: boolean;
}

function profile(options: ProfileOptions): DeviceProfile {
  const isModern = options.modernService ?? false;
  return {
    ...options,
    parentServiceUuid: isModern ? modernService : legacyService,
    rxChannelUuids: isModern ? modernRx : legacyRx,
    txChannelUuids: isModern ? modernTx : legacyTx,
    unlockUuid,
    requiresUnlock: options.requiresUnlock ?? true,
    supportsPairing: options.supportsPairing ?? true,
    supportsOsBondingOnly: options.supportsOsBondingOnly ?? false,
  };
}

const classic16Settings = {
  settingsReadAddress: 0x0010,
  settingsWriteAddress: 0x0054,
  unreadRecordsBytes: { start: 0x00, end: 0x10 },
  timeSyncBytes: { start: 0x2c, end: 0x3c },
  timeSyncFormat: 'classic16' as const,
};

const classic16Record = {
  recordByteSize: 0x10,
  transmissionBlockSize: 0x10,
  endianness: 'little' as const,
  recordFormat: 'classic16' as const,
};

const compactSettings = {
  settingsReadAddress: 0x0260,
  settingsWriteAddress: 0x0286,
  unreadRecordsBytes: { start: 0x00, end: 0x08 },
  timeSyncBytes: { start: 0x14, end: 0x1e },
  timeSyncFormat: 'compact14' as const,
};

export const deviceProfiles: readonly DeviceProfile[] = [
  profile({
    model: 'HEM-7150T',
    aliases: ['hem-7150t'],
    userStartAddresses: [0x0098],
    recordsPerUser: [60],
    ...classic16Record,
    settingsReadAddress: classic16Settings.settingsReadAddress,
    settingsWriteAddress: classic16Settings.settingsWriteAddress,
    unreadRecordsBytes: classic16Settings.unreadRecordsBytes,
    timeSyncBytes: classic16Settings.timeSyncBytes,
    timeSyncFormat: classic16Settings.timeSyncFormat,
  }),
  ...(['HEM-7155T', 'HEM-7156T'] as const).map((model) =>
    profile({
      model,
      aliases: [model.toLowerCase()],
      userStartAddresses: [0x0098, 0x0458],
      recordsPerUser: [60, 60],
      ...classic16Record,
      ...classic16Settings,
    }),
  ),
  profile({
    model: 'HEM-7322T',
    aliases: ['hem-7322t'],
    userStartAddresses: [0x02ac, 0x0824],
    recordsPerUser: [100, 100],
    recordByteSize: 0x0e,
    transmissionBlockSize: 0x38,
    endianness: 'big',
    recordFormat: 'compact14',
    compactYearStartBit: 16,
    ...compactSettings,
  }),
  ...(['HEM-7342T', 'HEM-7361T'] as const).map((model) =>
    profile({
      model,
      aliases: [model.toLowerCase()],
      userStartAddresses: [0x0098, 0x06d8],
      recordsPerUser: [100, 100],
      ...classic16Record,
      ...classic16Settings,
    }),
  ),
  profile({
    model: 'HEM-7377T1 (BP5360)',
    aliases: ['hem-7377t1'],
    userStartAddresses: [0x01cc, 0x080c],
    recordsPerUser: [100, 100],
    ...classic16Record,
    recordFormat: 'bp5360',
    settingsReadAddress: 0x0040,
    settingsWriteAddress: 0x0088,
    unreadRecordsBytes: { start: 0, end: 0 },
    timeSyncBytes: { start: 0, end: 0x10 },
    timeSyncFormat: 'bp5360',
    modernService: true,
    requiresUnlock: false,
    supportsPairing: false,
    supportsOsBondingOnly: true,
  }),
  profile({
    model: 'HEM-7380T1',
    aliases: ['hem-7380t1'],
    userStartAddresses: [0x01c4, 0x0804],
    recordsPerUser: [100, 100],
    ...classic16Record,
    settingsReadAddress: null,
    settingsWriteAddress: null,
    unreadRecordsBytes: null,
    timeSyncBytes: null,
    timeSyncFormat: null,
    modernService: true,
    requiresUnlock: false,
    supportsPairing: false,
    supportsOsBondingOnly: true,
  }),
  profile({
    model: 'HEM-7530T',
    aliases: ['hem-7530t'],
    userStartAddresses: [0x02e8],
    recordsPerUser: [90],
    recordByteSize: 0x0e,
    transmissionBlockSize: 0x10,
    endianness: 'big',
    recordFormat: 'compact14',
    compactYearStartBit: 18,
    settingsReadAddress: null,
    settingsWriteAddress: null,
    unreadRecordsBytes: null,
    timeSyncBytes: null,
    timeSyncFormat: null,
  }),
  profile({
    model: 'HEM-7600T',
    aliases: ['hem-7600t'],
    userStartAddresses: [0x02ac],
    recordsPerUser: [100],
    recordByteSize: 0x0e,
    transmissionBlockSize: 0x38,
    endianness: 'big',
    recordFormat: 'compact14',
    compactYearStartBit: 16,
    ...compactSettings,
  }),
  profile({
    model: 'HEM-6232T',
    aliases: ['hem-6232t'],
    userStartAddresses: [0x02e8, 0x0860],
    recordsPerUser: [100, 100],
    recordByteSize: 0x0e,
    transmissionBlockSize: 0x38,
    endianness: 'big',
    recordFormat: 'compact14SwapFlags',
    compactYearStartBit: 18,
    settingsReadAddress: 0x0260,
    settingsWriteAddress: 0x02a4,
    unreadRecordsBytes: { start: 0, end: 8 },
    timeSyncBytes: { start: 0x14, end: 0x1e },
    timeSyncFormat: null,
  }),
];

export function getDeviceProfile(name: string): DeviceProfile {
  const normalized = name.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  const match = deviceProfiles.find(
    (item) =>
      item.aliases.some((alias) => alias.toLowerCase() === normalized) ||
      item.model.toLowerCase() === normalized,
  );
  if (!match) {
    throw new Error(`Unsupported device "${name}". Supported models: ${deviceProfiles.flatMap((item) => item.aliases).join(', ')}`);
  }
  return match;
}

function readBits(data: Buffer, firstBit: number, lastBit: number, endianness: 'big' | 'little'): number {
  if (data.length === 0 || firstBit < 0 || lastBit < firstBit || lastBit >= data.length * 8) {
    throw new RangeError(`Invalid bit range ${firstBit}-${lastBit} for ${data.length}-byte record`);
  }
  let value = 0n;
  if (endianness === 'big') {
    for (const byte of data) value = (value << 8n) | BigInt(byte);
  } else {
    for (let index = data.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(data[index]);
  }
  const width = BigInt(lastBit - firstBit + 1);
  const shift = BigInt(data.length * 8 - lastBit - 1);
  return Number((value >> shift) & ((1n << width) - 1n));
}

function validDateTime(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    throw new RangeError(`Invalid date in record: ${year}-${month}-${day} ${hour}:${minute}:${second}`);
  }
  return date;
}

export function parseRecord(profile: DeviceProfile, bytes: Buffer): BloodPressureRecord {
  if (bytes.length !== profile.recordByteSize) {
    throw new RangeError(`Expected ${profile.recordByteSize} record bytes, received ${bytes.length}`);
  }

  let record: BloodPressureRecord;
  if (profile.recordFormat === 'classic16' || profile.recordFormat === 'bp5360') {
    const rawSys = readBits(bytes, 120, 127, 'little');
    if (profile.recordFormat === 'bp5360') {
      const year = readBits(bytes, 98, 103, 'little') + 2000;
      const month = readBits(bytes, 82, 85, 'little');
      const day = readBits(bytes, 86, 90, 'little');
      const hour = readBits(bytes, 91, 95, 'little');
      const minute = readBits(bytes, 68, 73, 'little');
      if (year < 2020 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
        throw new Error('record slot is empty');
      }
      const sys = rawSys + 25;
      const dia = readBits(bytes, 112, 119, 'little');
      const bpm = readBits(bytes, 104, 111, 'little');
      if (sys < 60 || sys > 250 || dia < 30 || dia > 150 || bpm < 30 || bpm > 200) {
        throw new Error('record values out of physiological range');
      }
      record = {
        datetime: validDateTime(year, month, day, hour, minute, Math.min(readBits(bytes, 74, 79, 'little'), 59)),
        dia,
        sys,
        bpm,
        mov: readBits(bytes, 80, 80, 'little'),
        ihb: readBits(bytes, 81, 81, 'little'),
      };
      return record;
    }
    if (profile.model === 'HEM-7380T1' && rawSys > 0xe1) throw new Error('record slot is empty');
    record = {
      datetime: validDateTime(
        readBits(bytes, 98, 103, 'little') + 2000,
        readBits(bytes, 82, 85, 'little'),
        readBits(bytes, 86, 90, 'little'),
        readBits(bytes, 91, 95, 'little'),
        readBits(bytes, 68, 73, 'little'),
        Math.min(readBits(bytes, 74, 79, 'little'), 59),
      ),
      dia: readBits(bytes, 112, 119, 'little'),
      sys: rawSys + 25,
      bpm: readBits(bytes, 104, 111, 'little'),
      mov: readBits(bytes, 80, 80, 'little'),
      ihb: readBits(bytes, 81, 81, 'little'),
    };
    return record;
  }

  const yearStart = profile.compactYearStartBit ?? 16;
  const year = readBits(bytes, yearStart, 23, 'big') + 2000;
  const isSwap = profile.recordFormat === 'compact14SwapFlags';
  record = {
    datetime: validDateTime(
      year,
      readBits(bytes, 34, 37, 'big'),
      readBits(bytes, 38, 42, 'big'),
      readBits(bytes, 43, 47, 'big'),
      readBits(bytes, 52, 57, 'big'),
      Math.min(readBits(bytes, 58, 63, 'big'), 59),
    ),
    dia: readBits(bytes, 0, 7, 'big'),
    sys: readBits(bytes, 8, 15, 'big') + 25,
    bpm: readBits(bytes, 24, 31, 'big'),
    mov: readBits(bytes, isSwap ? 33 : 32, isSwap ? 33 : 32, 'big'),
    ihb: readBits(bytes, isSwap ? 32 : 33, isSwap ? 32 : 33, 'big'),
  };
  return record;
}

export function readBitsFromSetting(data: Buffer, firstBit: number, lastBit: number, endianness: 'big' | 'little'): number {
  return readBits(data, firstBit, lastBit, endianness);
}

export function calculateRingBufferReadLocations(
  device: DeviceProfile,
  userIndex: number,
  unreadRecords: number,
  lastWrittenSlot: number,
): ReadCommand[] {
  const startAddress = device.userStartAddresses[userIndex];
  const recordsInRing = device.recordsPerUser[userIndex];
  if (startAddress === undefined || recordsInRing === undefined) {
    throw new RangeError(`Invalid user index ${userIndex} for ${device.model}`);
  }
  const recordByteSize = device.recordByteSize;

  if (lastWrittenSlot < unreadRecords) {
    return [
      { address: startAddress, size: recordByteSize * lastWrittenSlot },
      {
        address: startAddress + (recordsInRing + lastWrittenSlot - unreadRecords) * recordByteSize,
        size: recordByteSize * (unreadRecords - lastWrittenSlot),
      },
    ].filter((command) => command.size > 0);
  }
  return [{
    address: startAddress + recordByteSize * (lastWrittenSlot - unreadRecords),
    size: recordByteSize * unreadRecords,
  }];
}
