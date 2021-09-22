# CCS881 lib

A modern library for reading data from CCS881 sensors.

## Usage

```typescript
import { initialise, pollSensor } from 'ccs811';

(async () => {
  const handle = await initialise({
    bus: 1,
    address: 0x5a,
    pollPeriodMs: 1000
  });

  // ... Wait a few seconds. Note that a CCS811 becomes more accurate after 48 hours of burn in.
  const reading = await pollSensor(handle);
  console.log(`CO2: ${reading.co2}ppm`);
  console.log(`VOC: ${reading.voc}ppb`);
})();
```

The CCS811 is more accurate if it can adjust for ambient temperature and humidity. If you have this information, use the `setEnvironment` call to update it periodically

```typescript
// Environment is 27°C, 60% humidity
await setEnvironment(handle, 27, 60);
```

The polling period specified in the configuration passed to `initialise()` relates to how the CCS811 updates state internally. You still need to poll manually.
If a new reading is available, the reading status indicates this. This flag is cleared automatically.

```Typescript
async function delay(ms) {
  // return await for better async stack trace support in case of errors.
  return await new Promise(resolve => setTimeout(resolve, ms));
}

while (true) {
  await delay(250);
  const reading = await pollSensor(handle);
  if (reading.status.dataReady) {
    console.log(`New CO2 reading: ${reading.co2}ppm`);
  }
}
```

Note that is can take several seconds after the call to `initalise()` for data to become available. If an error occurs, sensors have been observed to read `0xfdfd`, but this is not specified in the Datasheet. Additionally, the readings prior to `dataReady` being set the first time will be zero and should be discarded.

## Physical connections

### Raspberry Pi

To connect to a Raspberry Pi:

- 3v3 to VCC
- GPIO2 (SDA) to SDA
- GPIO3 (SCL) to SCL
- GND to GND and WAK

![Raspberry Pi wiring diagram](circuit.png 'Raspberry Pi wiring')

This library was developed to operate on a Raspberry Pi. The CCS811 uses clock stretching, where it keeps the clock signal low to indicate that it needs a bit more time to complete some operation. The Raspberry Pi does not support this, but we can avoid the need if we reduce the i2c clock to 10kHz. Ensure the following is present in `/boot/config.txt`

```
# Enable i2c
dtparam=i2c_arm=o
# Reduce baud to 10Khz
dtparam=i2c_baudrate=10000
```

Also ensure that /etc/modules contains `i2c-dev`.
Apart from the baudrate changes, this can all be achieved by enabling i2c using the `raspi-config` command line tool.

## References

[Datasheet](https://cdn.sparkfun.com/assets/learn_tutorials/1/4/3/CCS811_Datasheet-DS000459.pdf)
