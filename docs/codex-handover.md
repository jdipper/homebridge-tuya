# Codex handover: shared Heating Programmes

Updated: 17 November 2026.

## Repositories, checkpoints and deployment state

Household heating is already split into device providers and a shared scheduler.
Do not repeat the old combined-plugin extraction or install its runtime beside
the shared owner.

| Component | Source | Last verified installed build, 17 November |
| --- | --- | --- |
| Heating Programmes | `jdipper/homebridge-heating-programmes`, `main` | `0.1.0-jdipper.8` |
| Tuya device provider | `jdipper/homebridge-tuya`, `main` | `2.7.3-jdipper.7` |
| Hive device provider | `@jdipper/homebridge-hivehome-control` | `1.1.0-jdipper.4` (unchanged) |

The paired updates were merged before installation:

- [Shared PR #1](https://github.com/jdipper/homebridge-heating-programmes/pull/1),
  merge `e44e043ac80a63f901591df448b638540933a897`.
- [Tuya PR #2](https://github.com/jdipper/homebridge-tuya/pull/2),
  merge `649edd377e03ae0e55d2a50e569dbad71697a24e`.

Implementation checkpoints before this handover:
- Shared: `f8dab72c2a9afc18073701c6414a29e4b3f4ee39`.
- Tuya: `aeb9ed78e9a3f4cf2bb9667af4ec98b26dfe713e`.

The public Shared repository has a clean history: the previously verified `.7`
source snapshot followed by this port, now merged into `main`. Private workspace
history, runtime files and installation receipts are not published.
Public commit authors use the GitHub handle and noreply address.

In the existing workspace, the publishable Git checkouts are
`public-repositories/homebridge-heating-programmes` and
`public-repositories/homebridge-tuya`. The older local repositories retain private
history for reference only; do not push all their branches or their old history.

The original Holiday work remains available in
[Tuya draft PR #1](https://github.com/jdipper/homebridge-tuya/pull/1), branch
`fix/holiday-programme-transitions`, checkpoint
`ec4d73eeb54f646fec117124aa60976ddc02c82c`. That is an older combined-plugin
implementation and a reference for the fixes, not the deployment baseline.

The paired builds were installed from checked local package archives and passed
read-only verification at **17 November 2026, 13:43:22 UTC**. They have not been
published to npm. Settings, saved profiles, history and pairing data were backed
up before installation. Only the Tuya and Heating Programmes child bridges were
restarted; the Hive bridge was preserved.

Verification confirmed the running versions, preserved configuration and policy,
historical native weeks and profiles, grouped control identity/names and provider
pairings. Heating write counters were unchanged. The installer and verifier sent
no thermostat writes and initiated no vendor probes; normal provider startup
traffic is separate from those checks. Four pre-existing programme warnings were
retained. Six FastWarm current-week snapshots await a fresh read after restart;
immutable historical versions remain preserved. No live programme-switch test,
network-isolation test or timer test was performed for this deployment.

## Programme delivery follow-up (candidate)

Tuya `2.7.3-jdipper.8` on `fix/fastwarm-programme-delivery` adds per-device spacing
between consecutive native programme packets after an observed middle-period
write was acknowledged but absent from complete readbacks. The earlier
installation table remains the deployed baseline until the new build is installed
and verified. Shared and Hive do not need code changes for this follow-up.
See [delivery behaviour and validation limits](fastwarm-programme-delivery.md) for
the regression, timing policy and controlled hardware validation plan. This
candidate passes **539 offline tests in 34 suites**, including the local socket
integration tests and 12 new pacing tests. The previous implementation fails the
new core regression. Build, standard lint and explicit schedule-manager lint pass.
Hardware validation and installation are still pending.

## Existing architecture and ownership

- Tuya owns authentication, device connections, measured temperatures, room
  discovery, native programme encoding, device queues and verified readbacks.
- Hive retains its own authentication, device accessories and guarded whole-week
  schedule operations. Its provider version does not change for this port.
- Heating Programmes owns the shared editor, saved Home/Away/Holiday drafts,
  enrollment, household intent, guest hold, Holiday return/preheat, history and
  progress for both systems.
- Providers and scheduler communicate over authenticated, versioned private Unix
  sockets. Separate child bridges are supported. Sockets live in the owner-only
  `heating-runtime` directory beside `persist`; JSON descriptors remain in
  `persist`. Vendor credentials never pass to the editor or scheduler.
- The persisted scheduler file is `persist/HeatingProgrammes.json`. Legacy Tuya
  profile files are read only for the existing one-time migration, not re-imported
  to replace newer shared settings.

The installed paired builds preserve one **Heating** accessory, UUID seed
`@jdipper/homebridge-heating-programmes:controls`, with ordinary Switch services
using stable `home` and `holiday` subtypes. Configured names are Heating Home and
Heating Holiday; custom names and the grouped accessory identity are retained.
Do not restore the older two-accessory migration from the reference PR.

## Ported household behaviour

- Holiday on shows Home off while remembering actual household occupancy.
- The grouped Home switch uses `/home`: Home on atomically ends Holiday, clears
  its return/preheat settings and selects Home. First-arrival automations using
  that switch have the same effect.
- `/presence` remains an occupancy-only route. The editor's Someone home and
  Everyone away buttons remember occupancy without cancelling Holiday.
- Home off during Holiday remembers absence without ending Holiday.
- Holiday off restores the latest remembered Home/Away choice. Unknown occupancy
  is not assumed to mean Away; an active guest hold can supply effective Home.
- Home/Away selections are immediate. The Away-delay setting, UI and settings
  route are removed. Old countdown fields are discarded without a startup upload.
- Guest hold and Holiday return/preheat remain separate deadline features. An
  overdue deadline after restart requires explicit recovery.
- A new automatic request prepares its own fresh Scheduled baseline. Manual
  previews retain their reviewed baseline and expiry/conflict checks.
- Later different requests survive earlier failed uploads. Failed identical
  requests and genuinely unknown outcomes are never automatically replayed or
  reported confirmed merely because a diagnostic read happens to match.
- A newer selection aborts obsolete automatic work. The provider finishes any
  submitted command, stops unsent commands, then releases the same device queue
  before the latest request prepares a fresh baseline. Writes do not overlap.
- Authenticated proof of a known supersession can permit a fresh latest request
  even after a Home/Away/Home round trip. A cancellation flag alone cannot turn
  an unknown native write into a safe identical retry.
- Obsolete success cannot confirm a newer request. Explicit selection after
  restart can restore a newer profile blocked behind a different interrupted
  request; startup and timer refreshes do not replay that request themselves.

An external delayed departure remains the automation's responsibility. Arrival
must invalidate the pending departure before selecting Home. Selecting Home
cannot cancel a sleeping shortcut that later sends Home off. Overlapping runs
need a restartable helper or per-run identifier. No external helper or shortcut
has been created by this work.

## Cancellation contract and API budget

The Tuya `.7` provider advertises `automaticCancellation: true`. Its authenticated
`/provider/cancel-automatic` route accepts only an owned automatic preview token
and does not wait behind that preview's applying queue. The callback reaches the
native packet guards and existing post-authentication HTTP dispatch guard.
Cancellation is local IPC, not another Tuya cloud connection or command.

Shared `.8` remains compatible with the earlier `.6` device provider by allowing
the already submitted apply operation to finish before preparing the latest
selection. That provider does not advertise or promise per-command cancellation.
Use the paired `.7` provider to obtain that stronger behaviour. Hive's single
whole-week command is allowed to finish once submitted; an obsolete unsent
preview is consumed/discarded locally without another cloud read or upload.

Preserve the validated optimisations: queue-owned one-shot fresh baselines,
grouped native inquiries and writes, memory-only capability caching, fresh group
membership/availability/mode checks and complete per-room readbacks. Do not add a
second controller baseline read or fall back to individual commands after an
uncertain group result.

For six changed FastWarm rooms, grouped inquiries and one packet per room, the
expected Home path requires 23 Tuya HTTP attempts cold or 22 warm. One identical
Away packet shared by all six is expected to require 19 cold or 18 warm. These
are projected normal paths backed by offline request-count regressions. The
no-change check was measured live at nine cold and eight warm. Authentication,
retries and unrelated polling are extra; none of these counts is a guarantee of
Tuya billing. Retain the distinction when estimating a monthly request budget.

Guarded Hive changes retain three cloud reads and one schedule upload; an already
matching week uses two reads and no upload. Hive traffic is separate from Tuya.

## Relevant code

In `homebridge-heating-programmes`:
- `src/controller/Controller.ts`, `ControlPolicy.ts`: shared policy, state queue,
  latest-intent handling, failed-request identity and lifecycle.
- `src/platform.ts`: stable grouped controls and `/home` handler binding.
- `src/tuya/TuyaIpcTransport.ts`: guarded preview ownership and local cancellation.
- `src/hive/`: single-week guarded upload, cancellation before submission and
  unchanged native Holiday/demand preconditions.
- `homebridge-ui/`: editor relay, immediate-selection help and script cache hash.

In `homebridge-tuya`:
- `src/device/schedule/TuyaProgrammeProvider.ts`,
  `TuyaProgrammeProviderServer.ts`: owned automatic leases and cancellation IPC.
- `src/device/schedule/FastWarmScheduleManager.ts`: native command boundaries,
  fresh baselines and full-week verification.
- Existing `FastWarmGroupCommandBroker.ts` and `TuyaOpenAPI.ts` dispatch guards
  remain the foundation for grouping and authenticated request safety.

## Hardware evidence and limits

FastWarm hardware is ET-63 / Smart WiFi 2.0, product `lmtejj3f4kafi2k1`, with seven
days and four periods per day. Existing cloud group tests changed one period on
all six group members and verified exact restoration. Six-byte event writes and
complete individual weekly readbacks are validated. A 21-byte full-day report
alone is not proof that the corresponding full-day write is supported.

The reported mixed Monday programme and Holiday restoration fault have simulated
regressions; this port has not established their exact physical cause or proved
the fix on hardware. Do not present them as live-resolved.

Do not enable temporary boosts/setbacks: the original combined Hold command failed
and later online sequence/timer results do not establish reliable restoration
across a changing native programme boundary. Keep the historical boundary jobs
and evidence frozen; do not rearm or reschedule them as part of this port.

WAN-independent execution of an uploaded week, thermostat clock retention/DST,
and local LAN programme compatibility remain distinct hardware checks. The linked
tuya-local exact-product report and TinyTuya/TuyAPI documentation in the original
handover justify investigation, not a compatibility claim. No LAN provider has
been added and no automatic cloud fallback is introduced.

## Validation and deployment safeguards

- Shared: `npm test` builds the plugin and passes all **268** offline tests,
  including the Unix-socket transport, editor relay and owner-lock suites.
- Tuya: `npm run lint` and `npm run build` pass. The command below passes **527**
  tests in **33** suites. Only the two real-account suites are excluded; local
  socket integration suites are included and pass.

  ```sh
  npm test -- --runInBand --watchman=false --testPathIgnorePatterns test/home.test.ts test/custom.test.ts
  ```

- Regression coverage includes both providers, failed Holiday then newer Home,
  unknown occupancy, Home/Away/Home cancellation, cancellation arriving before
  apply, interrupted restart restoration, stale/manual confirmation, grouped
  budget checks, fresh post-activation week proof and editor asset hashes.
- Known pre-claim cancellation requires an authenticated `notApplied: true`
  acknowledgement. A late apply, missing proof, failed cancellation or previously
  claimed write cannot invent that proof or convert an unknown outcome.
- Shared source/tests/handover and the full newly published Tuya content were
  checked for credentials and personal setup data. Runtime files, private
  installation receipts, dependency directories and old private author metadata
  are excluded from the public snapshots. The public source trees match the
  tested implementation trees exactly before these documentation-only commits.

For any future installation, back up saved profiles, history, enrollment, shared
policy, root configuration and child-bridge pairing/accessory caches. Keep the
paired versions together when checking command cancellation. Preserve
the existing grouped accessory/child bridge identities and provider configuration.

Shared policy remains schema version 1 but `.8` omits `awayDelayMinutes` and
`pendingAwayAt` when saving. A downgrade to `.7` requires restoring its matching
pre-upgrade `HeatingProgrammes.json` backup because `.7` requires those fields.
No rollback should invent a countdown, replay an interrupted upload or overwrite
a newer programme without review.

Read-only startup and both providers/controls were verified for this installation.
Any live programme-switch test still needs fresh baseline evidence and a specific
controlled plan. Do not infer hardware correctness from the offline suite or an
HTTP acknowledgement. Unknown writes require review; no automatic replay.
