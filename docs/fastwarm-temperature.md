# FastWarm room temperature

The FastWarm Smart WiFi 2.0 / ET-63 product `lmtejj3f4kafi2k1` reports measured
room temperature as `RoomTemper` (DP105, scale 1). Tuya's standard instruction
schema can omit it, causing the generic thermostat handler to display the target
as its current temperature.

This product profile reads the measured property through the existing cloud
session, exposes it as `temp_current`, and accepts subsequent raw MQTT updates.
For example, raw room temperature `195` displays as 19.5 C independently of a
`temp_set` value of `200` (20 C). A genuine standard `temp_current` is preferred
when the device already supplies it. No additional configuration is required.

The initial shadow read happens during discovery. Later HomeKit reads can request
a recovery read, with throttling, concurrent-request coalescing and backoff on
failures. Normal sensor changes use MQTT. The profile creates no polling timer.
Existing standard setpoint, power and display-unit command codes are retained.

For this exact product in Celsius, native `SetTemp` (DP102, scale 1) also feeds
the existing `temp_set` reading. The same read-only recovery request includes the
active native target. Native target changes and standard `temp_set` reports share
their own timestamp ordering, so changes made on the thermostat or by its built-in
programme remain distinct from measured room temperature and do not refresh the
room sensor's timestamp. Quoted source timestamps are retained, and stale or
far-future reports are ignored. This translation does not change the existing
standard setpoint command path or send target or programme writes.

If a measured value cannot be obtained, HomeKit reports it unavailable rather
than displaying the target as a measurement. The verified raw representation is
Celsius; Fahrenheit and unknown units report the current measurement unavailable
until their representation is verified. Heating-state inference for this product
uses Heat or Off; it cannot report Cooling.

Validation includes mocked cloud responses, packet ordering, missing/invalid
readings, API failures, discovery paths and HomeKit characteristics. The live
pilot on 7 November 2026 verified six room readings and separate current/target
HomeKit characteristics. Accepted reports retain separate source and receipt
timestamps for the dashboard and bounded local history. Cache reads do not
advance freshness, and implausibly future reports cannot poison the ordering
watermark. The temperature handler itself does not write heating settings; see
[the programme guide](fastwarm-profiles.md) for the separate explicit controls.
