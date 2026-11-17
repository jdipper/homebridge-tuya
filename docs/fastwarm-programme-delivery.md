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
all six FastWarm thermostats with zero programme warnings. A subsequent
controlled hardware test exercised the pacing change as described below.

The immutable installed archive was built from commit
`bf14951529230c0cf84661fe91b8c209a5ab420a`. Subsequent handover edits are
documentation only; they do not replace that archive or add runtime code or
dependencies. [PR #3](https://github.com/jdipper/homebridge-tuya/pull/3) records
the delivery change for this fork's `main` branch.

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

## Controlled hardware evidence

A controlled test passed on two thermostats after physical clock and weekday
confirmation. All four targets for a future Sunday were increased by 0.5°C while
the change times were retained. Both complete 28-period weeks were verified.
The original weeks were then restored from fresh conflict-checked baselines,
and all 28 periods were verified on both thermostats again. All four
write/restoration phases confirmed successfully, with no failed-phase replay
and no manual corrections. The observed programme-command attempt count matched
the planned 16 packets: four periods, two phases and two thermostats. Other read
and authentication requests are separate. Saved household drafts and current-day
programme periods were preserved.

This demonstrates multi-packet delivery and exact restoration for the installed
build, tested devices and packet pattern. It does not prove the exact cause of
the earlier dropped period or guarantee every firmware, network condition or
outage scenario. A future test still needs explicit authorisation, confirmed
physical clocks/weekdays, fresh baselines, future-only changes and verified
restoration. A no-change selection does not exercise multi-packet delivery.

An acknowledged command can still fail to reach a device. A future mismatch must
remain visible and require review; pacing is not grounds for claiming success
without complete native readback or silently retrying an uncertain outcome.
