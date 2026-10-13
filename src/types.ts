export interface BloodPressureRecord {
  datetime: Date;
  dia: number;
  sys: number;
  bpm: number;
  mov: number;
  ihb: number;
}

export interface ByteRange {
  start: number;
  end: number;
}

export interface DeviceProfile {
  readonly model: string;
  readonly aliases: readonly string[];
  readonly userStartAddresses: readonly number[];
  readonly recordsPerUser: readonly number[];
  readonly recordByteSize: number;
  readonly transmissionBlockSize: number;
  readonly endianness: 'big' | 'little';
  readonly recordFormat: 'classic16' | 'compact14' | 'compact14SwapFlags' | 'bp5360';
  readonly compactYearStartBit?: 16 | 18;
  readonly parentServiceUuid: string;
  readonly rxChannelUuids: readonly string[];
  readonly txChannelUuids: readonly string[];
  readonly unlockUuid: string;
  readonly requiresUnlock: boolean;
  readonly supportsPairing: boolean;
  readonly supportsOsBondingOnly: boolean;
  readonly settingsReadAddress: number | null;
  readonly settingsWriteAddress: number | null;
  readonly unreadRecordsBytes: ByteRange | null;
  readonly timeSyncBytes: ByteRange | null;
  readonly timeSyncFormat: 'classic16' | 'compact14' | 'bp5360' | null;
}

export interface ReadCommand {
  address: number;
  size: number;
}
