# omron-ble-connector

TypeScript command-line BLE connector for reading records from supported Omron blood-pressure monitors. It ports the BLE EEPROM protocol, model-specific record decoding and clock settings, CSV/UBPM export, and CSV plotting functionality from `omblepy`.

## Requirements

- Node.js 20 or later
- Bluetooth Low Energy adapter enabled by the operating system
- TypeScript 6.0.3 (pinned in `package.json`)

```sh
npm install
npm run build
```

Platform BLE access depends on Noble's native bindings and system Bluetooth stack. On Linux, BlueZ must be installed and the process needs permission to access the adapter. The default adapter is selected automatically; `--adapter hci1` selects a Linux HCI adapter explicitly. On Windows, `--pair` bonds with the monitor automatically and accepts the Windows pairing prompt without user interaction.

## Read measurements

```sh
npm start -- --device HEM-7322T
npm start -- --device hem-7322t --mac 11:22:33:44:55:66
```

Without `--mac`, the connector scans for eight seconds, lists discovered devices by signal strength, and prompts for a selection. Press Enter at the prompt to scan again. Use the model names/aliases below:

| Model | Alias |
| --- | --- |
| HEM-7150T | `hem-7150t` |
| HEM-7155T | `hem-7155t` |
| HEM-7156T | `hem-7156t` |
| HEM-7322T | `hem-7322t` |
| HEM-7342T | `hem-7342t` |
| HEM-7361T | `hem-7361t` |
| HEM-7377T1 / BP5360 | `hem-7377t1` |
| HEM-7380T1 | `hem-7380t1` |
| HEM-7530T | `hem-7530t` |
| HEM-7600T | `hem-7600t` |
| HEM-6232T | `hem-6232t` |

## RS7 Intelli IT (HEM-6232T) on Windows

Install dependencies and build the project:

```powershell
npm install
npm run build
```

Follow these steps in order:

1. **Pair once, if the monitor is not already paired.** If Windows has an old pairing saved, remove it from **Settings → Bluetooth & devices** first. Turn off Bluetooth on phones running the Omron app. Press and keep holding the monitor's Bluetooth button until `-P-` appears on the screen, then release the button. The pairing indicator stays on for about two minutes; run the pairing command while it is visible:

   ```powershell
   npm start -- --device hem-6232t --mac "00:5f:bf:93:fe:39" --pair
   ```

   Do not repeat this pairing step for every reading. Once paired, continue with step 2 on future readings.

2. **Take a blood-pressure measurement manually.** Put on the monitor and press its physical **START/STOP** button. Wait for the measurement to finish and be saved. The connector downloads saved measurements; it does not initiate a measurement.

3. **Enable Bluetooth transfer.** Press the monitor's Bluetooth button to make it available for transfer.

4. **Download the reading(s)** by running:

   ```powershell
   npm start -- --device hem-6232t --mac "00:5f:bf:93:fe:39"
   ```

   By default, this reads all stored records. To read only unread records and reset the monitor's unread-record counter, use:

   ```powershell
   npm start -- --device hem-6232t --mac "00:5f:bf:93:fe:39" --newRecOnly
   ```

   For BLE diagnostics, add `--loggerDebug`:

   ```powershell
   npm start -- --device hem-6232t --mac "00:5f:bf:93:fe:39" --loggerDebug
   ```

The `--` after `npm start` passes CLI options through npm. To run the built CLI directly without that separator, use `node .\dist\cli.js` instead, for example:

```powershell
node .\dist\cli.js --device hem-6232t --mac "00:5f:bf:93:fe:39"
```

Use `--pair` once for initial pairing. Most models use Omron key programming; HEM-7377T1 and HEM-7380T1 require OS-level bonding and should be paired through the operating system on platforms where Noble does not provide native bonding. Subsequent reads use the default key `deadbeaf12341234deadbeaf12341234`; `--key` accepts a custom 32-character hexadecimal key.

Windows pairing procedure: turn off Bluetooth on phones that have the Omron app, remove any existing Windows pairing of the monitor (Settings → Bluetooth & devices), hold the monitor's Bluetooth button until `-P-` blinks, then run the `--pair` command immediately. The monitor forgets its keys when it enters pairing mode, so a leftover Windows bond makes it unreachable. For later reads, press the monitor's Bluetooth button to start transfer mode; the monitor is only connectable for a short time, and "Device is unreachable" means it is not currently connectable. The monitor accepts a single connection, so close the Omron phone app first. Omron monitors advertise as `BLEsmart_<model><address>`, and the device chooser marks them with `<- Omron`; `--mac` connects directly without scanning.

Options:

| Option | Effect |
| --- | --- |
| `-d, --device <model>` | Required device model |
| `-m, --mac <address>` | BLE MAC address or device UUID; scan interactively if omitted |
| `-p, --pair` | Pair or program the device key |
| `-k, --key <hex>` | Custom 16-byte key, exactly 32 hexadecimal characters |
| `-n, --newRecOnly` | Read unread records and reset the device counter |
| `-t, --timeSync` | Synchronize the device clock to local system time |
| `--adapter <hciN>` | Select a Linux adapter such as `hci1` |
| `--loggerDebug` | Log BLE packet details |

`--newRecOnly` and `--timeSync` write settings back to device EEPROM. Only use them with a supported model and a device whose settings layout is known. HEM-7377T1's unread-counter location is not mapped, so new-record-only mode will not find records for that model. HEM-6232T and HEM-7530T do not support time synchronization in this connector.

Each successful read writes `user1.csv`, `user2.csv` as applicable, and `ubpm.json` in the current directory. Existing CSVs are backed up before being merged; records with a timestamp present in the latest read are replaced by that read's version.

## Verified physical devices

The following device has been tested end to end with this connector. Other entries in the supported-model list have not been physically verified as part of this project session.

| Device | Test environment | Pairing | Readout |
| --- | --- | --- | --- |
| HEM-6232T / RS7 Intelli IT | Windows, BLE | Pairing succeeded; key programmed | Read succeeded; 4 stored records exported |

## Plot exported CSV

The Python `plotCsv.py` GUI is replaced with a standalone interactive HTML chart:

```sh
npm start -- plot-csv user1.csv
npm start -- plot-csv user1.csv --window 30 --bin 7 --output pressure.html
```

`--window` (`--windowsize`) sets the visible chart window in days (default `7`); `--bin` (`--binsize`) sets the number of days averaged into each bar (default `1`). Open the generated HTML file in a browser and use its slider to move through the measurements.

## Development

```sh
npm test
```

Tests cover protocol checksum generation, device record decoding, ring-buffer address calculation, and CSV/UBPM formatting. Physical BLE communication requires an Omron monitor and a working BLE adapter.

## Origin

This project is the TypeScript equivalent of [`omblepy`](https://github.com/userx14/omblepy/tree/main), with its BLE protocol, device-specific record decoding, clock settings, CSV/UBPM export, and plotting functionality implemented for Node.js and TypeScript.
