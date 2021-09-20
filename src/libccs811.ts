import i2c from 'i2c-bus';
import { builtinModules } from 'module';

// prettier-ignore
const ccs811Registers = {
  STATUS:          0x00, // R,  1 byte,  app/boot
  MEAS_MODE:       0x01, // RW, 1 byte,  app
  ALG_RESULT_DATA: 0x02, // R,  8 bytes, app
  HW_ID:           0x20, // R,  1 byte,  app/boot
  APP_START:       0xF4, // W,  0 bytes, boot
  SW_RESET:        0xFF, // W,  4 bytes, app/boot
};

// Significant bit values in the STATUS register
// prettier-ignore
const STATUS_MASK = {
  FW_MODE:    0b10000000, // 0 -> boot mode, 1 -> app mode (e.g. ready)
  APP_VALID:  0b00100000, // 0 -> No firmware loaded, 1-> firmware loaded
  DATA_READY: 0b00010000, // 1 -> New sample ready
  ERROR:      0b00000001  // 1 -> Error occurred. Check ERROR_ID register
}

// prettier-ignore
const MEAS_MODE_MASK = {
  DRIVE_MODE_0: 0x00000000, // Measurements disabled
  DRIVE_MODE_1: 0x00010000, // 1 Hz
  DRIVE_MODE_2: 0x00100000, // 1/10 Hz
  DRIVE_MODE_3: 0x00110000, // 1/60 Hz
  DRIVE_MODE_4: 0x01000000  // 4 Hz. Note in this mode results must be read from RAW_RESULT, not ALG_RESULT_DATA
}

export interface CCS811Config {
  // The i2c bus the sensor is attached to
  bus: number;
  // The address on the i2c bus
  address: number;
  // How often the sensor should be polled
  pollPeriodMs: 1000 | 10000 | 60000;
}

export interface CCS811State {
  // The effective configuration
  config: CCS811Config;
  bus: i2c.PromisifiedBus;
}

const defaultConfig: CCS811Config = {
  bus: 1,
  address: 0x5a,
  pollPeriodMs: 1000
};

interface CCS811Result {
  c02: number; // ppm, typically around 400
  voc: number; // ppb
}

export async function initialise(userConfig: Partial<CCS811Config> = {}): Promise<CCS811State> {
  // Use default values if not specified
  const config: Readonly<CCS811Config> = Object.assign({}, defaultConfig, userConfig);

  // Open the bus
  const bus = await i2c.openPromisified(config.bus);

  // Initialise the sensor
  // First check we're actually talking to a CCS811
  const hw_id = await bus.readByte(config.address, ccs811Registers.HW_ID);
  if (hw_id != 0x81) {
    throw new Error(`HW_ID register value incorrect (expected 0x81, found ${hw_id})`);
  }

  // Reset the device
  bus.writeI2cBlock(config.address, ccs811Registers.SW_RESET, 4, Buffer.of(0x11, 0xe5, 0x72, 0x8a));

  // Read status register
  const status = await bus.readByte(config.address, ccs811Registers.STATUS);
  if ((status & STATUS_MASK.APP_VALID) === 0) {
    // No firmware present
    // Firmware loading not yet supported
    throw new Error('Firmware not present');
  }

  // Transition from boot mode to app mode
  await bus.writeI2cBlock(config.address, ccs811Registers.APP_START, 0, Buffer.alloc(0));

  // Set read mode
  switch (config.pollPeriodMs) {
    case 1000:
      bus.writeByte(config.address, ccs811Registers.MEAS_MODE, MEAS_MODE_MASK.DRIVE_MODE_1);
      break;
    case 10000:
      bus.writeByte(config.address, ccs811Registers.MEAS_MODE, MEAS_MODE_MASK.DRIVE_MODE_1);
      break;
    case 60000:
      bus.writeByte(config.address, ccs811Registers.MEAS_MODE, MEAS_MODE_MASK.DRIVE_MODE_3);
      break;
    default:
      // Error case for Javascript callers
      throw new Error(`Unsupported polling period (${config.pollPeriodMs}ms)`);
  }

  return {
    bus,
    config
  };
}

export async function setEnvironment(state: CCS811State, temperature: number, humidity: number): Promise<void> {}

export async function pollSensor(state: CCS811State): Promise<CCS811Result> {
  const algResult = await state.bus.readI2cBlock(
    state.config.address,
    ccs811Registers.ALG_RESULT_DATA,
    8,
    Buffer.alloc(8)
  );
  return {
    c02: (algResult.buffer[0] << 8) | algResult.buffer[1],
    voc: (algResult.buffer[2] << 8) | algResult.buffer[3]
  };
}
