import type { Characteristic, Peripheral } from '@stoprocent/noble';
import { calculateRingBufferReadLocations, parseRecord, readBitsFromSetting } from './devices';
import type { BloodPressureRecord, DeviceProfile, ReadCommand } from './types';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

interface ResponsePacket {
  packetType: Buffer;
  eepromAddress: Buffer;
  data: Buffer;
}

interface PendingResponse {
  resolve(packet: ResponsePacket): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class OmronBleTransport {
  private readonly rxCharacteristics: Characteristic[] = [];
  private readonly txCharacteristics: Characteristic[] = [];
  private readonly channelBuffers: Array<Buffer | undefined> = [undefined, undefined, undefined, undefined];
  private readonly notificationListeners: Array<((data: Buffer, isNotification: boolean) => void) | undefined> = [];
  private readonly subscribedChannels = new Set<number>();
  private notificationsEnabled = false;
  private pendingResponse: PendingResponse | undefined;

  constructor(
    private readonly peripheral: Peripheral,
    private readonly device: DeviceProfile,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    const { services, characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    if (!services.some((service) => service.uuid.toLowerCase() === this.device.parentServiceUuid.toLowerCase())) {
      throw new Error(`Required Omron BLE service ${this.device.parentServiceUuid} was not found`);
    }

    for (const uuid of this.device.rxChannelUuids) {
      const characteristic = characteristics.find((item) => item.uuid.toLowerCase() === uuid.toLowerCase());
      if (!characteristic) throw new Error(`BLE receive characteristic ${uuid} was not found`);
      this.rxCharacteristics.push(characteristic);
    }
    for (const uuid of this.device.txChannelUuids) {
      const characteristic = characteristics.find((item) => item.uuid.toLowerCase() === uuid.toLowerCase());
      if (!characteristic) throw new Error(`BLE transmit characteristic ${uuid} was not found`);
      this.txCharacteristics.push(characteristic);
    }
    if (this.rxCharacteristics.length > this.channelBuffers.length) {
      throw new Error(`Unsupported Omron profile: ${this.rxCharacteristics.length} receive channels`);
    }
  }

  async startTransmission(): Promise<void> {
    await this.enableNotifications();
    const response = await this.sendAndReceive(Buffer.from('0800000000100018', 'hex'));
    if (!response.packetType.equals(Buffer.from('8000', 'hex'))) {
      throw new Error('Invalid response to data readout start');
    }
  }

  async endTransmission(): Promise<void> {
    const response = await this.sendAndReceive(Buffer.from('080f000000000007', 'hex'));
    if (!response.packetType.equals(Buffer.from('8f00', 'hex'))) {
      throw new Error('Invalid response to data readout end');
    }
    if (response.data[0] !== 0) {
      throw new Error(`Device reported error status code ${response.data[0]} while ending transmission`);
    }
    await this.disableNotifications();
  }

  async readContinuous(address: number, byteCount: number, blockSize = 0x10): Promise<Buffer> {
    if (!Number.isInteger(byteCount) || byteCount < 0) throw new RangeError('Read length must be a non-negative integer');
    if (blockSize < 1 || blockSize > 0xff) throw new RangeError('BLE block size must be between 1 and 255');
    const result: Buffer[] = [];
    let currentAddress = address;
    let remaining = byteCount;
    while (remaining > 0) {
      const size = Math.min(remaining, blockSize);
      result.push(await this.readBlock(currentAddress, size));
      currentAddress += size;
      remaining -= size;
    }
    return Buffer.concat(result);
  }

  async writeContinuous(address: number, bytes: Buffer, blockSize = 0x08): Promise<void> {
    if (blockSize < 1 || blockSize > 0xff) throw new RangeError('BLE block size must be between 1 and 255');
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      const part = bytes.subarray(offset, offset + blockSize);
      await this.writeBlock(address + offset, part);
    }
  }

  async writeNewUnlockKey(key: Buffer): Promise<void> {
    if (!this.device.supportsPairing) throw new Error(`${this.device.model} does not support custom-key pairing`);
    if (key.length !== 16) throw new RangeError(`Pairing key must be 16 bytes, received ${key.length}`);
    const characteristic = await this.unlockCharacteristic();
    const rx = this.rxCharacteristics[0];
    if (!rx) throw new Error('No receive characteristic is configured');
    await rx.subscribeAsync();
    try {
      await characteristic.subscribeAsync();
      let response: Buffer | undefined;
      for (let attempt = 1; attempt <= 10; attempt++) {
        response = await this.writeUnlockAndWait(characteristic, Buffer.concat([Buffer.from([0x02]), Buffer.alloc(16)]));
        if (response.subarray(0, 2).equals(Buffer.from('8200', 'hex'))) break;
        this.logger.debug(`Key programming attempt ${attempt}/10 returned ${response.subarray(0, 2).toString('hex')}`);
        if (attempt === 10) {
          throw new Error(`Could not enter key programming mode after 10 attempts; last response: ${response.toString('hex')}`);
        }
        await delay(1000);
      }
      response = await this.writeUnlockAndWait(characteristic, Buffer.concat([Buffer.from([0x00]), key]));
      if (!response.subarray(0, 2).equals(Buffer.from('8000', 'hex'))) {
        throw new Error(`Failed to program the pairing key; response: ${response.toString('hex')}`);
      }
      this.logger.info('Pairing key programmed successfully');
    } finally {
      await characteristic.unsubscribeAsync();
      await rx.unsubscribeAsync();
    }
  }

  async unlockWithKey(key: Buffer): Promise<void> {
    if (!this.device.requiresUnlock) return;
    if (key.length !== 16) throw new RangeError(`Pairing key must be 16 bytes, received ${key.length}`);
    const characteristic = await this.unlockCharacteristic();
    await characteristic.subscribeAsync();
    try {
      const response = await this.writeUnlockAndWait(characteristic, Buffer.concat([Buffer.from([0x01]), key]));
      if (!response.subarray(0, 2).equals(Buffer.from('8100', 'hex'))) {
        throw new Error('The pairing key does not match the key stored on the device');
      }
    } finally {
      await characteristic.unsubscribeAsync();
    }
  }

  async close(): Promise<void> {
    if (this.pendingResponse) {
      clearTimeout(this.pendingResponse.timer);
      this.pendingResponse.reject(new Error('BLE transport closed'));
      this.pendingResponse = undefined;
    }
    await this.disableNotifications();
  }

  private async enableNotifications(): Promise<void> {
    if (this.notificationsEnabled) return;
    for (let index = 0; index < this.rxCharacteristics.length; index++) {
      const characteristic = this.rxCharacteristics[index];
      const listener = (data: Buffer): void => this.onNotification(index, data);
      characteristic.on('data', listener);
      this.notificationListeners[index] = listener;
      try {
        await characteristic.subscribeAsync();
        this.subscribedChannels.add(index);
      } catch (error) {
        characteristic.removeListener('data', listener);
        this.notificationListeners[index] = undefined;
        throw error;
      }
    }
    this.notificationsEnabled = true;
  }

  private async disableNotifications(): Promise<void> {
    if (this.subscribedChannels.size === 0) {
      this.notificationsEnabled = false;
      return;
    }
    let cleanupError: unknown;
    for (let index = 0; index < this.rxCharacteristics.length; index++) {
      if (!this.subscribedChannels.has(index)) continue;
      const characteristic = this.rxCharacteristics[index];
      const listener = this.notificationListeners[index];
      if (listener) characteristic.removeListener('data', listener);
      this.subscribedChannels.delete(index);
      try {
        await characteristic.unsubscribeAsync();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    this.channelBuffers.fill(undefined);
    this.notificationsEnabled = false;
    if (cleanupError) throw new Error(`Failed to unsubscribe from an Omron BLE receive channel: ${errorMessage(cleanupError)}`, { cause: cleanupError });
  }

  private onNotification(channelIndex: number, data: Buffer): void {
    this.channelBuffers[channelIndex] = Buffer.from(data);
    this.logger.debug(`rx ch${channelIndex} < ${data.toString('hex')}`);
    const header = this.channelBuffers[0];
    if (!header || header.length === 0) return;

    let packet: Buffer;
    if (this.rxCharacteristics.length === 1) {
      packet = header;
      this.channelBuffers.fill(undefined);
    } else {
      const packetLength = header[0];
      const channelCount = Math.ceil(packetLength / 16);
      if (channelCount > this.rxCharacteristics.length || channelCount > this.channelBuffers.length) {
        this.failPending(new Error(`Invalid response packet length ${packetLength} for ${this.rxCharacteristics.length} channels`));
        this.channelBuffers.fill(undefined);
        return;
      }
      const chunks = this.channelBuffers.slice(0, channelCount);
      if (chunks.some((chunk) => chunk === undefined)) return;
      packet = Buffer.concat(chunks.filter((chunk): chunk is Buffer => chunk !== undefined)).subarray(0, packetLength);
      this.channelBuffers.fill(undefined);
    }

    if (packet.length < 8) {
      this.failPending(new Error(`Omron response packet is too short: ${packet.toString('hex')}`));
      return;
    }
    const crc = packet.reduce((checksum, byte) => checksum ^ byte, 0);
    if (crc !== 0) {
      this.failPending(new Error(`Corrupt Omron response, XOR checksum is 0x${crc.toString(16)}: ${packet.toString('hex')}`));
      return;
    }
    const packetType = packet.subarray(1, 3);
    const dataLength = packet[5];
    const payload =
      packetType.equals(Buffer.from('8f00', 'hex'))
        ? packet.subarray(6, 7)
        : dataLength > packet.length - 8
          ? Buffer.alloc(dataLength, 0xff)
          : packet.subarray(6, 6 + dataLength);
    this.pendingResponse?.resolve({
      packetType,
      eepromAddress: packet.subarray(3, 5),
      data: payload,
    });
  }

  private async sendAndReceive(command: Buffer, timeoutMs = 1000): Promise<ResponsePacket> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const responsePromise = new Promise<ResponsePacket>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pendingResponse?.timer === timer) this.pendingResponse = undefined;
          reject(new Error(`No response after ${timeoutMs} ms`));
        }, timeoutMs);
        this.pendingResponse = { resolve, reject, timer };
      });
      try {
        await this.send(command);
        const response = await responsePromise;
        if (this.pendingResponse) clearTimeout(this.pendingResponse.timer);
        this.pendingResponse = undefined;
        return response;
      } catch (error) {
        if (this.pendingResponse) clearTimeout(this.pendingResponse.timer);
        this.pendingResponse = undefined;
        if (attempt === 5) throw new Error(`BLE command failed after 5 attempts: ${errorMessage(error)}`, { cause: error });
        this.logger.warn(`Transmission failed; retry ${attempt}/5`);
      }
    }
    throw new Error('BLE retry loop exhausted');
  }

  private async send(command: Buffer): Promise<void> {
    const channelWidth = this.txCharacteristics.length === 1 ? Math.max(16, command.length) : 16;
    const channelCount = Math.ceil(command.length / channelWidth);
    if (channelCount > this.txCharacteristics.length) {
      throw new RangeError(`Command needs ${channelCount} TX channels, profile has ${this.txCharacteristics.length}`);
    }
    for (let index = 0; index < channelCount; index++) {
      const characteristic = this.txCharacteristics[index];
      const chunk = command.subarray(index * channelWidth, (index + 1) * channelWidth);
      const withoutResponse = this.txCharacteristics.length === 1;
      this.logger.debug(`tx ch${index} > ${chunk.toString('hex')}`);
      await characteristic.writeAsync(chunk, withoutResponse);
    }
  }

  private async readBlock(address: number, size: number): Promise<Buffer> {
    const command = Buffer.from([0x08, 0x01, 0x00, address >> 8, address & 0xff, size, 0x00]);
    const response = await this.sendAndReceive(appendXorChecksum(command));
    this.validateMemoryResponse(response, address, '8100', 'read');
    return response.data;
  }

  private async writeBlock(address: number, data: Buffer): Promise<void> {
    if (data.length > 0xff) throw new RangeError('EEPROM write block cannot exceed 255 bytes');
    const header = Buffer.from([data.length + 8, 0x01, 0xc0, address >> 8, address & 0xff, data.length]);
    const response = await this.sendAndReceive(appendXorChecksum(Buffer.concat([header, data, Buffer.from([0x00])])));
    this.validateMemoryResponse(response, address, '81c0', 'write');
  }

  private validateMemoryResponse(response: ResponsePacket, address: number, expectedType: string, operation: string): void {
    const expectedAddress = Buffer.from([address >> 8, address & 0xff]);
    if (!response.eepromAddress.equals(expectedAddress)) {
      throw new Error(`EEPROM ${operation} response address ${response.eepromAddress.toString('hex')} does not match 0x${address.toString(16)}`);
    }
    if (!response.packetType.equals(Buffer.from(expectedType, 'hex'))) {
      throw new Error(`Invalid packet type in EEPROM ${operation} response: ${response.packetType.toString('hex')}`);
    }
  }

  private async unlockCharacteristic(): Promise<Characteristic> {
    const { characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    const characteristic = characteristics.find(
      (item) => item.uuid.toLowerCase() === this.device.unlockUuid.toLowerCase(),
    );
    if (!characteristic) throw new Error(`BLE unlock characteristic ${this.device.unlockUuid} was not found`);
    return characteristic;
  }

  private async writeUnlockAndWait(characteristic: Characteristic, command: Buffer): Promise<Buffer> {
    let timer: NodeJS.Timeout | undefined;
    let onData: ((data: Buffer, isNotification: boolean) => void) | undefined;
    const responsePromise = new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => {
        if (onData) characteristic.removeListener('data', onData);
        reject(new Error('Timed out waiting for unlock characteristic response'));
      }, 10_000);
      onData = (data: Buffer): void => {
        clearTimeout(timer);
        if (onData) characteristic.removeListener('data', onData);
        resolve(Buffer.from(data));
      };
      characteristic.on('data', onData);
    });
    try {
      await characteristic.writeAsync(command, false);
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (onData) characteristic.removeListener('data', onData);
      throw error;
    }
    return responsePromise;
  }

  private failPending(error: Error): void {
    this.pendingResponse?.reject(error);
  }
}

export async function readDeviceRecords(
  transport: OmronBleTransport,
  device: DeviceProfile,
  pairingKey: Buffer,
  options: { onlyNew: boolean; syncTime: boolean; logger: Logger },
): Promise<BloodPressureRecord[][]> {
  if (options.onlyNew && !device.unreadRecordsBytes) {
    throw new Error(`${device.model} does not expose an unread-record counter`);
  }
  if (options.syncTime && (!device.timeSyncBytes || !device.timeSyncFormat)) {
    throw new Error(`${device.model} does not support time synchronization`);
  }

  await transport.unlockWithKey(pairingKey);
  await transport.startTransmission();
  let cachedSettings: Buffer | undefined;
  try {
    const needsSettings = options.onlyNew || options.syncTime;
    if (needsSettings) {
      if (device.settingsReadAddress === null || device.settingsWriteAddress === null) {
        throw new Error(`${device.model} has no settings EEPROM configuration`);
      }
      cachedSettings = Buffer.alloc(device.settingsWriteAddress - device.settingsReadAddress);
      for (const range of [device.unreadRecordsBytes, device.timeSyncBytes]) {
        if (!range) continue;
        const size = range.end - range.start;
        if (size >= 54) throw new RangeError('Settings section is too large for one read');
        if (size > 0) {
          cachedSettings.set(
            await transport.readContinuous(device.settingsReadAddress + range.start, size, size),
            range.start,
          );
        }
      }
    }

    const commandsByUser = options.onlyNew
      ? getNewRecordCommands(device, cachedSettings!)
      : getAllRecordCommands(device);
    if (options.onlyNew && device.unreadRecordsBytes!.start === device.unreadRecordsBytes!.end) {
      options.logger.warn(`${device.model} unread-record counter is not mapped; no new records will be downloaded`);
    }
    const recordsByUser: BloodPressureRecord[][] = [];
    options.logger.info('Reading stored measurements; this may take a while');
    for (let userIndex = 0; userIndex < commandsByUser.length; userIndex++) {
      const parts: Buffer[] = [];
      for (const command of commandsByUser[userIndex]) {
        if (command.size > 0) {
          parts.push(await transport.readContinuous(command.address, command.size, device.transmissionBlockSize));
        }
      }
      const userBytes = Buffer.concat(parts);
      const userRecords: BloodPressureRecord[] = [];
      for (let offset = 0; offset + device.recordByteSize <= userBytes.length; offset += device.recordByteSize) {
        const bytes = userBytes.subarray(offset, offset + device.recordByteSize);
        if (bytes.every((byte) => byte === 0xff)) continue;
        try {
          userRecords.push(parseRecord(device, bytes));
        } catch (error) {
          options.logger.warn(
            `Could not parse user ${userIndex + 1}, offset ${offset}, data ${bytes.toString('hex')}: ${errorMessage(error)}; skipping record`,
          );
        }
      }
      recordsByUser.push(userRecords);
    }

    if (options.onlyNew) resetUnreadRecordsCounter(device, cachedSettings!);
    if (options.syncTime) {
      const timeRange = device.timeSyncBytes!;
      const bytes = buildTimeSyncBytes(device, cachedSettings!, new Date(), options.logger);
      await transport.writeContinuous(device.settingsWriteAddress! + timeRange.start, bytes, bytes.length);
    }
    if (options.onlyNew) {
      const range = device.unreadRecordsBytes!;
      const bytes = cachedSettings!.subarray(range.start, range.end);
      if (bytes.length > 0) {
        await transport.writeContinuous(device.settingsWriteAddress! + range.start, bytes, bytes.length);
      }
    }
    return recordsByUser;
  } finally {
    await transport.endTransmission();
  }
}

function getAllRecordCommands(device: DeviceProfile): ReadCommand[][] {
  return device.userStartAddresses.map((address, index) => [
    { address, size: device.recordsPerUser[index] * device.recordByteSize },
  ]);
}

function getNewRecordCommands(device: DeviceProfile, settings: Buffer): ReadCommand[][] {
  const range = device.unreadRecordsBytes!;
  const unreadSettings = settings.subarray(range.start, range.end);
  if (unreadSettings.length === 0) return device.userStartAddresses.map(() => []);
  return device.userStartAddresses.map((_, index) => {
    const lastWrittenSlot = readBitsFromSetting(
      unreadSettings.subarray(index * 2, index * 2 + 2),
      8,
      15,
      device.endianness,
    );
    const unreadRecords = readBitsFromSetting(
      unreadSettings.subarray(index * 2 + 4, index * 2 + 6),
      8,
      15,
      device.endianness,
    );
    return calculateRingBufferReadLocations(device, index, unreadRecords, lastWrittenSlot);
  });
}

export function resetUnreadRecordsCounter(device: DeviceProfile, settings: Buffer): void {
  const range = device.unreadRecordsBytes!;
  const current = settings.subarray(range.start, range.end);
  if (current.length < 8) return;
  const resetValue = device.endianness === 'big' ? [0x80, 0x00] : [0x00, 0x80];
  for (const offset of [4, 6]) {
    current[offset] = resetValue[0];
    current[offset + 1] = resetValue[1];
  }
}

export function buildTimeSyncBytes(device: DeviceProfile, settings: Buffer, now: Date, logger: Logger): Buffer {
  const range = device.timeSyncBytes!;
  const current = settings.subarray(range.start, range.end);
  let result: Buffer;
  if (device.timeSyncFormat === 'classic16') {
    const [year, month, day, hour, minute, second] = current.subarray(8, 14);
    logDeviceDate(logger, year + 2000, month, day, hour, minute, second);
    result = Buffer.concat([
      current.subarray(0, 8),
      Buffer.from([now.getFullYear() - 2000, now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]),
    ]);
    result = Buffer.concat([result, Buffer.from([sumBytes(result) & 0xff, 0x00])]);
  } else if (device.timeSyncFormat === 'compact14') {
    const [month, year, hour, day, second, minute] = current.subarray(2, 8);
    logDeviceDate(logger, year + 2000, month, day, hour, minute, second);
    result = Buffer.concat([
      current.subarray(0, 2),
      Buffer.from([now.getMonth() + 1, now.getFullYear() - 2000, now.getHours(), now.getDate(), now.getSeconds(), now.getMinutes()]),
    ]);
    result = Buffer.concat([result, Buffer.from([0x00, sumBytes(result) & 0xff])]);
  } else {
    const [year, month, day, hour, minute, second] = current.subarray(8, 14);
    logDeviceDate(logger, year + 2000, month, day, hour, minute, second);
    const prefix = Buffer.from(current.subarray(0, 8));
    prefix[4] = 0x01;
    result = Buffer.concat([
      prefix,
      Buffer.from([now.getFullYear() - 2000, now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]),
    ]);
    result = Buffer.concat([result, Buffer.from([sumBytes(result) & 0xff, 0x00])]);
  }
  if (result.length !== current.length) {
    throw new Error(`${device.model} time settings expected ${current.length} bytes, generated ${result.length}`);
  }
  settings.set(result, range.start);
  logger.info(`Device time updated to ${formatDateTime(now)}`);
  return result;
}

function logDeviceDate(logger: Logger, year: number, month: number, day: number, hour: number, minute: number, second: number): void {
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second
  ) {
    logger.info(`Device time is ${formatDateTime(date)}`);
  } else {
    logger.warn('Device currently contains an invalid date');
  }
}

function formatDateTime(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function sumBytes(bytes: Buffer): number {
  return bytes.reduce((sum, byte) => sum + byte, 0);
}

export function appendXorChecksum(bytes: Buffer): Buffer {
  const checksum = bytes.reduce((value, byte) => value ^ byte, 0);
  return Buffer.concat([bytes, Buffer.from([checksum])]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
