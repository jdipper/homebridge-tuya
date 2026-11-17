# FastWarm programme connection

Household programme selection and editing have moved to the separate **Heating
Programmes** controller. This Tuya plugin supplies the device connection only.

It reads the complete native ET-63 week, reports room temperatures and SmartLife
room names, prepares a fresh five-minute programme preview, and applies a preview
once. Applying requires the same native week, mode and grouping observed during
preparation. Changed periods are sent using the verified single-event DP119 wire
format, then the complete week and Scheduled mode are read back.

The device uses four temperature periods per day. Supported targets are 5–40°C
in 0.5°C increments. Seven-day programming and Celsius are required. No missing
period or midnight event is invented. An unknown upload result is reported for
review and is never automatically replayed.

The former saved profiles file remains unchanged for migration by the shared
controller. The provider does not read it, select a profile, run presence or
Holiday timers, or publish Apple Home household controls.
