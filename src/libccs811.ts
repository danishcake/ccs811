import i2c from 'i2c-bus';

/**
 * Registers used by this library
 */
// prettier-ignore
const ccs811Registers = {
  STATUS:          0x00, // R,  1 byte,  app/boot
  MEAS_MODE:       0x01, // RW, 1 byte,  app
  ALG_RESULT_DATA: 0x02, // R,  8 bytes, app
  ENV_DATA:        0x05, // W,  4 bytes, app
  HW_ID:           0x20, // R,  1 byte,  app/boot
  APP_START:       0xF4, // W,  0 bytes, boot
  SW_RESET:        0xFF, // W,  4 bytes, app/boot
};

/**
 * The bits that can be set in the STATUS register
 */
// prettier-ignore
const STATUS_MASK = {
  FW_MODE:    0b10000000, // 0 -> boot mode, 1 -> app mode (e.g. ready)
  APP_VALID:  0b00010000, // 0 -> No firmware loaded, 1-> firmware loaded
  DATA_READY: 0b00001000, // 1 -> New sample ready
  ERROR:      0b00000001  // 1 -> Error occurred. Check ERROR_ID register
}

/**
 * Measurement modes that can be written to the MEAS_MODE register
 * Additional bits are used to control interrupts, which are not used
 */
// prettier-ignore
const MEAS_MODE_MASK = {
  DRIVE_MODE_0: 0b00000000, // Measurements disabled
  DRIVE_MODE_1: 0b00010000, // 1 Hz
  DRIVE_MODE_2: 0b00100000, // 1/10 Hz
  DRIVE_MODE_3: 0b00110000, // 1/60 Hz
  DRIVE_MODE_4: 0b01000000  // 4 Hz. Note in this mode results must be read from RAW_RESULT, not ALG_RESULT_DATA
}

/**
 * The error bits that can be set in the ERROR_ID register
 */
// prettier-ignore
const ERROR_ID_MASK = {
  WRITE_REG_INVALID: 0b00000001, // Write to invalid mailbox
  READ_REG_INVALID:  0b00000010, // Read from invalid mailbox
  MEASMODE_INVALID:  0b00000100, // Invalid measurement mode requested
  MAX_RESISTANCE:    0b00001000, // Resistance limit exceeded
  HEATER_FAULT:      0b00010000, // Heater current out of bounds
  HEATER_SUPPLY:     0b00100000  // Heater voltage out of bounds
}

/**
 * Configuration that controls how the CCS811 sensor is configured
 */
export interface CCS811Config {
  // The i2c bus the sensor is attached to
  bus: number;
  // The address on the i2c bus
  address: number;
  // How often the sensor should be polled
  pollPeriodMs: 1000 | 10000 | 60000;
}

/**
 * State handle. Obtain one use initialise, and pass it to other functions
 */
export interface CCS811State {
  // The effective configuration
  config: CCS811Config;
  // The opened bus
  bus: i2c.PromisifiedBus;
}

/**
 * Default configuration values for parameters not specified in the call to initialise
 */
const defaultConfig: CCS811Config = {
  bus: 1,
  address: 0x5a,
  pollPeriodMs: 1000
};

/**
 * The result of polling the CCS811 sensor
 */
interface CCS811Result {
  co2: number; // ppm, typically around 400
  voc: number; // ppb
  status: {
    dataReady: boolean; // The above data is a new reading
    error: boolean; // An error has been encounted
  };
  errorId: {
    writeRegInvalid: boolean; // i2c write to invalid register.
    readRegInvalid: boolean; // i2c read from invalid register
    measurementModeInvalid: boolean; // Unsupported measurement mode requested. Unlikely to occur!
    maxResistance: boolean; // Sensor resistance measurement has exceeded limit.
    heaterFault: boolean; // Current to heater out of bounds
    heaterSupply: boolean; // Voltage to heater out of bounds
  };
}

/**
 * An awaitable delay
 * @param ms Period to wait, in milliseconds
 */
async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialises the sensor, preparing it for reading
 * @param userConfig Configuration for how to setup the sensor
 * @returns A handle that is passed to other functions
 */
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

  // Reset the device so it's in a known state
  // t_START has a worst case of 70ms, so we'll wait 100 to be safe
  await bus.writeI2cBlock(config.address, ccs811Registers.SW_RESET, 4, Buffer.of(0x11, 0xe5, 0x72, 0x8a));
  await delay(100);

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
  // For simplicity, we only support the 'normal' polling modes
  switch (config.pollPeriodMs) {
    case 1000:
      await bus.writeByte(config.address, ccs811Registers.MEAS_MODE, MEAS_MODE_MASK.DRIVE_MODE_1);
      break;
    case 10000:
      await bus.writeByte(config.address, ccs811Registers.MEAS_MODE, MEAS_MODE_MASK.DRIVE_MODE_1);
      break;
    case 60000:
      await bus.writeByte(config.address, ccs811Registers.MEAS_MODE, MEAS_MODE_MASK.DRIVE_MODE_3);
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

/**
 * Closes the library by resetting the CCS811 sensor.
 * Calling this is not usually necessary, as initialise calls it internally
 */
export async function close(state: CCS811State): Promise<void> {
  // Reset the device so it's in a known state
  await state.bus.writeI2cBlock(state.config.address, ccs811Registers.SW_RESET, 4, Buffer.of(0x11, 0xe5, 0x72, 0x8a));
}

/**
 * Sets the environment data. This is used by the CCS811 to provide more accurate data.
 * If this isn't called, the sensor assumes 50% humidity and 25°C
 * @param state Handle returned by initialise
 * @param temperature The current temperate in °C
 * @param humidity The current relative humidity
 */
export async function setEnvironment(state: CCS811State, temperature: number, humidity: number): Promise<void> {
  // Pack the humidity and temperature data
  // Both are stored in a big-endian 7.9 fixed point format (LSB is 1/512th). This can represent values between
  // 0 and 127.99ish
  // Temperature is offset so that a stored value of zero represents -25°C, leading to a range of
  // -25 to 102.99ish

  // Clamp input humidity to 0 - 100
  humidity = Math.max(0, Math.min(100, humidity));

  // Clamp input temperature to -25 - 100 and apply offset
  temperature = Math.max(-25, Math.min(100, temperature)) + 25;

  /**
   * Packs the input as fixed point 7.9
   * @param value An input. Only values in the range 0-127.99 can be correctly represented
   * @returns The input value packed in 7.9 format
   */
  const toFixedPoint = (value: number): Buffer => {
    value *= 512;
    const integerPart = (value & 0b1111_1110_0000_0000) >> 9;
    const fractionalPart = value & 0b0000_0001_1111_1111;

    const result = Buffer.alloc(2);
    result[0] = (integerPart << 1) | ((fractionalPart >> 8) & 0x01);
    result[1] = fractionalPart & 0xff;

    return result;
  };

  const environmentMessage = Buffer.concat([toFixedPoint(humidity), toFixedPoint(temperature)]);
  await state.bus.writeI2cBlock(state.config.address, ccs811Registers.ENV_DATA, 4, environmentMessage);
}

/**
 * Poll the sensor
 * @param state Handle returned by intialise
 * @returns The latest sensor readings, and associated status/errors
 */
export async function pollSensor(state: CCS811State): Promise<CCS811Result> {
  // Read the sensor. This returns
  // [eCO2 High Byte, eCO2 Low Byte, TVOC High Byte, TVOC Low Byte, STATUS, ERROR_ID, RAW_DATA_0, RAW_DATA_1]
  const algResult = await state.bus.readI2cBlock(
    state.config.address,
    ccs811Registers.ALG_RESULT_DATA,
    8,
    Buffer.alloc(8)
  );

  // Unpack the buffer into easy to use results
  return {
    co2: (algResult.buffer[0] << 8) | algResult.buffer[1],
    voc: (algResult.buffer[2] << 8) | algResult.buffer[3],
    status: {
      dataReady: (algResult.buffer[4] & STATUS_MASK.DATA_READY) !== 0,
      error: (algResult.buffer[4] & STATUS_MASK.ERROR) !== 0
    },
    errorId: {
      writeRegInvalid: (algResult.buffer[5] & ERROR_ID_MASK.WRITE_REG_INVALID) !== 0,
      readRegInvalid: (algResult.buffer[5] & ERROR_ID_MASK.READ_REG_INVALID) !== 0,
      measurementModeInvalid: (algResult.buffer[5] & ERROR_ID_MASK.MEASMODE_INVALID) !== 0,
      maxResistance: (algResult.buffer[5] & ERROR_ID_MASK.MAX_RESISTANCE) !== 0,
      heaterFault: (algResult.buffer[5] & ERROR_ID_MASK.HEATER_FAULT) !== 0,
      heaterSupply: (algResult.buffer[5] & ERROR_ID_MASK.HEATER_SUPPLY) !== 0
    }
  };
}
