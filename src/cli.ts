#!/usr/bin/env node
import nobleDefault, { withBindings } from '@stoprocent/noble';
import type { Noble, Peripheral } from '@stoprocent/noble';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createPlot } from './plot-csv';
import { getDeviceProfile } from './devices';
import { OmronBleTransport, readDeviceRecords, type Logger } from './protocol';
import { saveRecords } from './storage';

interface CliOptions {
  device?: string;
  address?: string;
  pair: boolean;
  onlyNew: boolean;
  syncTime: boolean;
  key?: string;
  adapter?: string;
  debug: boolean;
}

const logger: Logger = {
  debug: (message) => {
    if (debugEnabled) log('DEBUG', message);
  },
  info: (message) => log('INFO', message),
  warn: (message) => log('WARNING', message),
};
let debugEnabled = false;

async function main(args: string[]): Promise<void> {
  if (args[0] === 'plot-csv') {
    await runPlotCommand(args.slice(1));
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const options = parseOptions(args);
  debugEnabled = options.debug;
  const device = getDeviceProfile(options.device!);
  const pairingKey = parsePairingKey(options.key);
  if (options.address && !isBluetoothAddress(options.address)) {
    throw new Error(`Invalid Bluetooth MAC address or UUID: ${options.address}`);
  }
  if (options.pair && !device.supportsPairing && !device.supportsOsBondingOnly) {
    throw new Error(`${device.model} does not support pairing through this connector`);
  }

  const noble = makeNoble(options.adapter);
  const peripherals = await discoverPeripherals(noble, options.address);
  const peripheral = options.address
    ? peripherals.find((item) => addressMatches(item, options.address!))
    : await choosePeripheral(noble, peripherals);
  if (!peripheral) throw new Error(`Bluetooth device ${options.address} was not found while scanning`);

  logger.info(`Connecting to ${peripheral.address || peripheral.id}${peripheral.advertisement.localName ? ` (${peripheral.advertisement.localName})` : ''}`);
  await peripheral.connectAsync();
  let transport: OmronBleTransport | undefined;
  try {
    if (options.pair && device.supportsOsBondingOnly) {
      try {
        await peripheral.pairAsync();
      } catch (error) {
        throw new Error(
          `OS-level BLE bonding failed. Pair ${device.model} in your operating system's Bluetooth settings first, then retry. ${errorMessage(error)}`,
          { cause: error },
        );
      }
      logger.info('OS-level BLE bonding completed');
      return;
    }

    transport = new OmronBleTransport(peripheral, device, logger);
    await transport.initialize();
    if (options.pair) {
      await transport.writeNewUnlockKey(pairingKey);
      await transport.startTransmission();
      await transport.endTransmission();
      return;
    }

    logger.info('Communication started');
    const records = await readDeviceRecords(transport, device, pairingKey, {
      onlyNew: options.onlyNew,
      syncTime: options.syncTime,
      logger,
    });
    await saveRecords(records);
    logger.info('Communication finished');
    logger.info(`Saved ${records.reduce((total, userRecords) => total + userRecords.length, 0)} records to user CSV files and ubpm.json`);
  } finally {
    try {
      if (transport) await transport.close();
    } finally {
      if (peripheral.state === 'connected') await peripheral.disconnectAsync();
    }
  }
}

async function runPlotCommand(args: string[]): Promise<void> {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let windowDays = 7;
  let binDays = 1;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--window' || arg === '--windowsize' || arg === '-w') {
      windowDays = parsePositiveInteger(args[++index], arg);
    } else if (arg === '--bin' || arg === '--binsize' || arg === '-b') {
      binDays = parsePositiveInteger(args[++index], arg);
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++index];
      if (!outputPath) throw new Error(`${arg} requires a file path`);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown plot option: ${arg}`);
    } else if (!inputPath) {
      inputPath = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!inputPath) throw new Error('Usage: omron-ble-connector plot-csv <input.csv> [--window 7] [--bin 1] [--output chart.html]');
  const output = await createPlot(inputPath, { windowDays, binDays, outputPath });
  console.log(`Created interactive chart: ${output}`);
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { pair: false, onlyNew: false, syncTime: false, debug: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--device' || arg === '-d') options.device = requiredValue(args[++index], arg);
    else if (arg === '--mac' || arg === '-m') options.address = requiredValue(args[++index], arg);
    else if (arg === '--key' || arg === '-k') options.key = requiredValue(args[++index], arg);
    else if (arg === '--adapter') options.adapter = requiredValue(args[++index], arg);
    else if (arg === '--pair' || arg === '-p') options.pair = true;
    else if (arg === '--newRecOnly' || arg === '-n') options.onlyNew = true;
    else if (arg === '--timeSync' || arg === '-t') options.syncTime = true;
    else if (arg === '--loggerDebug') options.debug = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.device) throw new Error('The --device option is required; use --help to see supported devices');
  return options;
}

function makeNoble(adapter?: string): Noble {
  if (!adapter) return nobleDefault;
  const match = /^hci(\d+)$/i.exec(adapter);
  if (!match) throw new Error(`Invalid adapter "${adapter}". Use a Linux adapter name such as hci0`);
  return withBindings('hci', { deviceId: Number(match[1]) });
}

async function discoverPeripherals(noble: Noble, target?: string): Promise<Peripheral[]> {
  await noble.waitForPoweredOnAsync(20_000);
  const discovered = new Map<string, Peripheral>();
  let resolveTarget: ((peripheral: Peripheral | undefined) => void) | undefined;
  const targetMatch = target
    ? new Promise<Peripheral | undefined>((resolve) => {
        resolveTarget = resolve;
      })
    : undefined;
  const timer = target ? setTimeout(() => resolveTarget?.(undefined), 30_000) : undefined;
  const listener = (peripheral: Peripheral): void => {
    discovered.set(peripheral.id, peripheral);
    if (target && addressMatches(peripheral, target)) resolveTarget?.(peripheral);
  };
  noble.on('discover', listener);
  let scanning = false;
  try {
    await noble.startScanningAsync([], true);
    scanning = true;
    if (targetMatch) {
      const match = await targetMatch;
      if (match) discovered.set(match.id, match);
    } else {
      await delay(8000);
    }
  } finally {
    if (timer) clearTimeout(timer);
    noble.removeListener('discover', listener);
    if (scanning) await noble.stopScanningAsync();
  }
  return [...discovered.values()].sort((left, right) => right.rssi - left.rssi);
}

async function choosePeripheral(noble: Noble, initialPeripherals: Peripheral[]): Promise<Peripheral> {
  let peripherals = initialPeripherals;
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      if (peripherals.length === 0) {
        console.log('No Bluetooth devices found. Check Bluetooth is enabled and the Omron device is advertising.');
      } else {
        console.log('Select an Omron device:');
        peripherals.forEach((peripheral, index) => {
          console.log(`${index}: ${peripheral.address || peripheral.id}\t${peripheral.advertisement.localName || '(unnamed)'}\tRSSI ${peripheral.rssi}`);
        });
      }
      const answer = await readline.question('Device number, or press Enter to rescan: ');
      if (answer.trim() === '') {
        peripherals = await discoverPeripherals(noble);
        continue;
      }
      const index = Number(answer);
      if (!Number.isInteger(index) || index < 0 || index >= peripherals.length) {
        console.log(`Enter a number from 0 to ${peripherals.length - 1}, or press Enter to rescan.`);
        continue;
      }
      return peripherals[index];
    }
  } finally {
    readline.close();
  }
}

function parsePairingKey(value?: string): Buffer {
  if (value === undefined) return Buffer.from('deadbeaf12341234deadbeaf12341234', 'hex');
  if (!/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error('The pairing key must be exactly 32 hexadecimal characters (16 bytes)');
  }
  return Buffer.from(value, 'hex');
}

function isBluetoothAddress(value: string): boolean {
  return /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function addressMatches(peripheral: Peripheral, address: string): boolean {
  const normalized = address.toLowerCase();
  return peripheral.address.toLowerCase() === normalized || peripheral.id.toLowerCase() === normalized;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
  return value;
}

function parsePositiveInteger(value: string | undefined, option: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${option} must be a positive whole number`);
  return result;
}

function log(level: string, message: string): void {
  console.log(`${new Date().toISOString()} - omron-ble-connector - ${level} - ${message}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(`Omron Bluetooth LE measurement reader

Usage:
  omron-ble-connector --device <model> [options]
  omron-ble-connector plot-csv <input.csv> [options]

BLE options:
  -d, --device <model>  Device model (e.g. hem-7322t; required)
  -m, --mac <address>   Bluetooth MAC address or device UUID (scan if omitted)
  -p, --pair            Pair or program the device key (first connection only)
  -k, --key <hex>       32-character pairing key (default: built-in key)
  -n, --newRecOnly      Download unread records and reset the device counter
  -t, --timeSync        Set the device clock from system time
      --adapter <hciN>  Linux adapter to use, e.g. hci1
      --loggerDebug     Enable BLE packet diagnostics
  -h, --help            Show this help

Plot options:
  -w, --window <days>   Visible chart window (default: 7)
  -b, --bin <days>      Average measurements across this many days (default: 1)
  -o, --output <file>   Output HTML file (default: <input-name>.html)`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
});
