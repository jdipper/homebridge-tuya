# FastWarm programme delivery

An observed multi-packet programme change stored Wake and Return temperatures
while retaining the previous Leave temperature. The cloud accepted all commands,
but three complete readback inquiries and a later independent inquiry still
showed the missing Leave change. A separately reviewed update of only the
remaining Leave entries subsequently verified the complete intended weeks.

The planner included the Leave entries. The delivery loop awaited each cloud
HTTP response and immediately sent the next packet. Cloud acknowledgement and
native processing can be asynchronous; the observed pattern is consistent with
device or cloud processing/coalescing, but does not establish the exact cause.
Tuya's [Send Property API](https://developer.tuya.com/en/docs/cloud/c057ad5cfd?id=Kcp2kxdzftp91)
does not return a stored programme, so the full native readback remains the
authority for success.

## Delivery policy

Tuya `2.7.3-jdipper.8` adds a one-second minimum interval after an acknowledged
native programme packet before another programme packet for that thermostat. It
uses monotonic time, keeps different thermostats independent and guards unsent packets
again after the wait. Shutdown, availability/connection changes and superseded
automatic selections stop further transmission. Reusing a queue does not bypass
the remaining interval.

This interval is a conservative mitigation, not a documented ET-63 timing
guarantee. There is no per-packet cloud query, new command retry or automatic
rewrite after a mismatch. The existing packet shapes, day grouping, cross-device
group capability checks, queue ownership and complete-week verification remain
in place. A first packet has no added wait. One-packet operations retain their
normal request count and latency unless an earlier acknowledged packet for the
same thermostat is still within the interval.

## Installation and validation status

Tuya `2.7.3-jdipper.8` is installed and passed static verification. The shared
Heating Programmes and Hive builds remain unchanged at `0.1.0-jdipper.8` and
`1.1.0-jdipper.4`. Only the Tuya child bridge was restarted. Configuration, saved
profiles, historical programme versions, pairing identities and grouped controls
were preserved. Fresh read-only checks established complete 28-period weeks for
all six FastWarm thermostats with zero programme warnings. These checks confirm
stored programmes and do not demonstrate the pacing change on hardware.

The immutable installed archive was built from commit
`bf14951529230c0cf84661fe91b8c209a5ab420a`. Subsequent handover edits are
documentation only; they do not replace that archive or add runtime code or
dependencies. Source branch `fix/fastwarm-programme-delivery` remains in
[draft PR #3](https://github.com/jdipper/homebridge-tuya/pull/3) pending controlled
hardware validation.

The complete offline Tuya suite passes **539 tests in 34 suites**, including
**12 delivery-pacing regressions**. Only the two real-account suites are excluded;
local socket integration tests are included. The new core regression fails
against the previous implementation. The build, standard lint command and
explicit lint of the nested schedule manager pass. The static installer/verifier
passes **39 tests** and the guarded hardware-test helper passes **15 offline
tests**.

The regression models prompt HTTP acknowledgements while the native thermostat
is still busy, causing an unpaced middle packet to be lost. It must establish
that all intended events are stored when pacing is enabled, with the same cloud
request count and no replay. Separate tests cover the first-packet path,
per-device independence, monotonic timing and stopping unsent commands.

Hardware validation of the delivery interval is still pending. A prepared
future-period test stopped at preflight because the physical thermostat clock
and weekday had not been confirmed. That confirmation remains pending. No test
programme writes were sent.

A controlled test should change several future periods on an affected thermostat,
verify all 28 periods, restore the original week using a fresh conflict-checked
baseline and verify restoration. Saved household drafts and current-day temperatures should be kept
unchanged. The test needs explicit approval for its specified writes. A no-change
Home selection does not exercise multi-packet delivery.

An acknowledged command can still fail to reach a device. A future mismatch must
remain visible and require review; pacing is not grounds for claiming hardware
success or silently retrying an uncertain outcome.
