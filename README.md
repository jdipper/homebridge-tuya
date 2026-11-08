# Homebridge Tuya — FastWarm fork

[![Build and Lint](https://github.com/jdipper/homebridge-tuya/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/jdipper/homebridge-tuya/actions/workflows/build.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

This is [jdipper's fork](https://github.com/jdipper/homebridge-tuya) of
[homebridge-plugins/homebridge-tuya](https://github.com/homebridge-plugins/homebridge-tuya),
with FastWarm thermostat temperature support, a household programme editor and
security fixes. The original project builds on `0x5e/homebridge-tuya-platform`.

**`main` contains the combined build for this fork.** Security and thermostat
display fixes also have separate branches for possible upstream pull requests.
The scheduling features are maintained in this fork. See
[branches and upstream contributions](#branches-and-upstream-contributions).

This fork's npm package is **`@jdipper/homebridge-tuya`**, starting with version
**`2.7.2-jdipper.2`**, and displays **Homebridge Tuya (jdipper FastWarm)**.
It has its own npm update source. The upstream package is
`@homebridge-plugins/homebridge-tuya`; its Homebridge verification status belongs
to the original project. This fork is not a separately verified release.

## Features

- Measured room temperature shown separately from the target on supported FastWarm
  Smart WiFi 2.0 / ET-63 thermostats, including native temperature updates.
- SmartLife room names in the Homebridge editor, with optional local aliases.
- Independent **Home**, **Away** and **Holiday** weekly programmes per room, each
  with four temperature periods per day.
- Import the programmes already stored on the thermostats, or use one shared
  editor to prepare a programme for all or selected rooms.
- Separate draft saving, preview and application, with complete native programme
  readback and confirmation for each room.
- Apple Home switches for household presence and Holiday, plus an Away delay,
  guest hold and optional Holiday return/preheat time in Homebridge.
- Local temperature history and saved programme versions.
- Credential redaction, private diagnostic/state files and cancellation of
  superseded smart-lock requests.
- The upstream Tuya device integrations, Scenes (Tap-to-Run) and configurable
  device/schema overrides.

FastWarm support targets product ID `lmtejj3f4kafi2k1`; Celsius is the verified
temperature format. See [room temperature support](docs/fastwarm-temperature.md),
[programme controls](docs/fastwarm-profiles.md) and the
[editor guide](homebridge-ui/README.md).

## Getting started with FastWarm

1. Install this fork and configure its existing Tuya cloud connection using the
   [configuration guide](#configuration).
2. Open the Tuya plugin's configuration page in Homebridge and choose
   **Thermostats**. Select seven-day programming in SmartLife before applying
   weekly profiles.
3. Choose a Home, Away or Holiday profile and use **Load stored programmes** to
   import each room's current programme. Use **Edit programme for all rooms** for
   one shared editor, with room selection to limit its scope.
4. Save the drafts, then choose **Review & apply**. Saving or importing a draft
   does not change the heating; application uploads the programme and selects
   Scheduled mode. Check the room confirmations after application.
5. Save all three profiles for a room before enabling **Use saved profiles for
   automatic household changes**. That room will then follow subsequent household
   selections.

The two separate accessories in Apple Home select household programmes:

| Accessory | On | Off |
| --- | --- | --- |
| Heating Home | Select Home | Select Away after the configured delay |
| Heating Holiday | Select Holiday, with priority over presence | Resume the Home/Away selection |

Set the initial household presence, then configure automations to turn **Heating
Home** on when the first person arrives and off when the last person leaves.
Presence changes during Holiday are remembered. The default Away delay is 30
minutes and can be changed in the editor.

Apple Home provides these on/off controls; the programme tables, application
progress and Holiday return date/time are in Homebridge. Expand **Presence,
guests & holiday return** to set a return time and optional Home preheat lead.
Saving a Holiday return enables Holiday immediately. At the deadline, Holiday
ends and the latest presence/guest hold chooses Home or Away.
Unknown presence or an overdue return after a restart requires review in
Homebridge.

## Current validation limits

- **Boosts and temporary setbacks are disabled.** Hardware testing has not yet
  established reliable Hold and timed restoration across programme changes.
- Programme uploads, household profile changes and Holiday return/preheat need
  Homebridge running with a working Tuya internet connection.
- The thermostat stores its uploaded weekly programme. Execution during a WAN
  outage, clock retention after power loss and daylight-saving behaviour still
  need hardware validation.
- Each room is checked against all 28 native periods after an upload. An
  interrupted upload can leave a partial programme. Review a failure and use
  **Verify saved Home/Away/Holiday programme** for a fresh read-only check before
  deciding whether to apply again.

The [programme guide](docs/fastwarm-profiles.md) describes conflict handling,
confirmation, restart recovery and the remaining hardware checks.


## Supported Tuya Devices
See [SUPPORTED_DEVICES.md](./SUPPORTED_DEVICES.md)


## Changelogs
See [CHANGELOG.md](./CHANGELOG.md)


## Installation

Use a Node.js version supported by your Homebridge installation; the plugin's
version ranges are listed in [package.json](./package.json). Preserve your
Homebridge configuration and persist directory when replacing an installation.
Run one Tuya implementation at a time. The upstream
`@homebridge-plugins/homebridge-tuya` and older `homebridge-tuya-platform` plugins
cannot run alongside this package with the same `TuyaPlatform` configuration.

### Install from npm

Install `@jdipper/homebridge-tuya` through your Homebridge plugin manager.
For a local npm-managed installation, run this from
its storage directory:

```sh
npm install --save-exact @jdipper/homebridge-tuya@2.7.2-jdipper.2
```

Future updates to this package come from the fork's npm releases. Publishing is
described in the [npm release guide](docs/npm-publishing.md).

### Migrate an existing installation

Back up the Homebridge configuration, persist directory and installed plugin.
Replace the existing Tuya package with `@jdipper/homebridge-tuya`, ensuring the
old implementation is removed before restarting Homebridge. Keep the
`TuyaPlatform` configuration, its name and child bridge username unchanged.
Restart Homebridge after changing the package name so it discovers the new
plugin and can reassociate cached accessories.

Thermostat UUIDs and saved programme instance IDs are unchanged. Heating Home
and Heating Holiday retain the earlier fork's UUID namespace so their existing
Apple Home identities can be reused. Keep the full backup until room readings,
saved programmes and household controls have been verified after migration.

The earlier GitHub release `v2.7.2-jdipper.1` used the upstream package name. Its
archive does not install the new npm package.

### Build this fork

Compiled files are not tracked in Git, so build before installing:

```sh
git clone --branch main --single-branch https://github.com/jdipper/homebridge-tuya.git
cd homebridge-tuya
npm ci
npm run build
npm pack --ignore-scripts
```

Copy the generated `.tgz` to the Homebridge host and install it using that host's
plugin installation method. For a local npm-managed Homebridge installation,
run the following from its storage directory, replacing the example path with
the actual archive path:

```sh
npm install --save /absolute/path/to/generated-package.tgz
```

Restart the Tuya child bridge, or Homebridge if it does not use a child bridge.
Keep the existing `TuyaPlatform` configuration. When replacing the upstream
package, follow the migration steps above because the npm package name differs.

### Upstream npm release

Searching Homebridge's plugin catalogue for `@homebridge-plugins/homebridge-tuya`,
or running `npm install @homebridge-plugins/homebridge-tuya`, installs the upstream
release. To install this fork, use `@jdipper/homebridge-tuya` or build this
repository.


## Configuration

There are two types of projects: `Custom` and `Smart Home`.
The difference between them is:
- The `Custom` project pulls devices from the project's assets.
- The `Smart Home` project pulls devices from the user's home in the Tuya app.

If you are a personal user and are unsure which one to choose, please use the `Smart Home` project.

Before you can configure, you must go to the [Tuya IoT Platform](https://iot.tuya.com):
- Create a cloud development project, and select the data center where your app account is located. See [Mappings Between OEM App Accounts and Data Centers](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb) or [Countries Regions and Tuya Data Center](https://github.com/tuya/tuya-home-assistant/wiki/Countries-Regions-and-Tuya-Data-Center)
- Go to the `Project Page` > `Devices Panel` > `Link Tuya App Account`, and link your app account.
- Go to the `Project Page` > `Service API` > `Go to Authorize`, and subscribe to the following APIs (it is free for trial):
    - Authorization Token Management
    - Device Status Notification
    - IoT Core
    - IoT Video Live Stream (for cameras)
    - Industry Project Client Service (for the `Custom` project)
    - IR Control Hub Open Service (for IR devices)
    - Smart Home Scene Linkage (for scenes)
    - Smart Lock Open Service (for Lock devices)
- Check the active services and expiry dates in your Tuya cloud project. Access
  must remain active for the plugin's cloud operations; trial and renewal terms
  are managed by Tuya.

#### For "Custom" Project

- `platform` - **required** : Must be 'TuyaPlatform'.
- `options.projectType` - **required** : Must be '1'
- `options.endpoint` - **required** : The endpoint URL taken from the [API Reference > Endpoints](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4#title-1-Endpoints) table.
- `options.accessId` - **required** : The Access ID obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud).
- `options.accessKey` - **required** : The Access Secret obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud).
- `options.debug` - **optional**: Includes debugging output in the Homebridge log. (Default: `false`)
- `options.debugLevel` - **optional**: An optional list of strings seperated with comma `,`. `api` represents for HTTP API log, `mqtt` represents for MQTT log, and device ID represents for device log. If blank, all logs are outputed.

#### For "Smart Home" Project

- `platform` - **required** : Must be 'TuyaPlatform'.
- `options.projectType` - **required** : Must be '2'.
- `options.accessId` - **required** : The Access ID obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud).
- `options.accessKey` - **required** : The Access Secret obtained from [Tuya IoT Platform > Cloud Develop](https://iot.tuya.com/cloud).
- `options.countryCode` - **required** : The numeric country code of your developer account's region. You can find the country codes list [here](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb).
- `options.username` - **required** : The mobile app (Tuya or SmartLife) account's username. Don't use the Tuya IoT Platform developer username.
- `options.password` - **required** : The mobile app (Tuya or SmartLife) account's password. MD5 salted password is also available for increased security. Don't use the Tuya IoT Platform developer password.
- `options.appSchema` - **required** : The app schema: 'tuyaSmart' for the Tuya Smart App, or 'smartlife' for the Smart Life App.
- `options.endpoint` - **optional** : The endpoint URL can be inferred from the [API Reference > Endpoints](https://developer.tuya.com/en/docs/iot/api-request?id=Ka4a8uuo1j4t4#title-1-Endpoints) table based on the country code provided. Only manually set this value if you encounter login issues and need to specify the endpoint for your account location.
- `options.homeWhitelist` - **optional**: An array of integer values for the home IDs you want to whitelist. If provided, only devices with matching Home IDs will be included. You can find the Home ID in the Homebridge log.
- `options.debug` - **optional**: Includes debugging output in the Homebridge log. (Default: `false`)
- `options.debugLevel` - **optional**: An optional list of strings seperated with comma `,`. `api` represents for API and MQTT log, device ID represents for specific device log. If blank, all logs are outputed.


#### Advanced options
See [ADVANCED_OPTIONS.md](./ADVANCED_OPTIONS.md)

If your device has manufacturer-specific features that are not part of Tuya's standard device definition, enable `addExtraFeaturesAutomatically` in that device's `options.deviceOverrides` entry. The plugin will expose supported read/write non-standard datapoints in HomeKit as extra services: Boolean datapoints become switches, Enum datapoints become switches for their available values, and Integer datapoints become sliders.

For example:

```json
{
  "options": {
    "deviceOverrides": [{
      "id": "{device_id}",
      "addExtraFeaturesAutomatically": true
    }]
  }
}
```

This option applies only to the specified device and does not replace the standard accessory controls. For unsupported datapoint types, or when you need to control exactly which datapoints are exposed, use the `extra` and `extraRawSwitch` properties in the device schema. See [ADVANCED_OPTIONS.md](./ADVANCED_OPTIONS.md) for details.

Garage door controllers that keep `switch_1=true` can opt in to contact-sensor-only state reads with `garageDoorUseContactSensorForState` in `options.deviceOverrides`. This keeps commands on `switch_1`, but reads HomeKit state from `doorcontact_state`.


#### FastWarm thermostat programmes (experimental)

For supported FastWarm ET-63 thermostats, the configuration page shows compact
room cards using SmartLife room names, with optional local name overrides. Each
room can have Home, Away and Holiday temperature programmes. Load each
thermostat's stored programme into its own draft, or edit one shared programme
for all or selected rooms. Saving drafts and reviewing/applying them are separate
steps; loading does not change the heating. Apple Home household automations
select Home/Away, with Holiday taking priority. See [setup, behaviour and current
hardware-validation limits](docs/fastwarm-profiles.md).

## Limitations
- Tuya cloud API access must remain active; check the expiry dates in your project.
- Using the same app account for multiple Homebridge/HomeAssistant instances is not supported. Please use separate app accounts for each instance.
- The plugin requires an internet connection to the Tuya Cloud and does not support the LAN protocol. See [#90](https://github.com/homebridge-plugins/homebridge-tuya/issues/90) for more information.

## FAQ

#### About Login issue

For most users, you can easily find your app account's data center through the [documentation](https://developer.tuya.com/en/docs/iot/oem-app-data-center-distributed?id=Kafi0ku9l07qb) and login without any issues. However, for some users, they may encounter error codes such as 1106 or 2406. If you encounter such errors, it's possible that there are differences between your data center and the documentation.

To determine the data center, follow these steps:

1. Open the app and navigate to "Me > Settings > Network Diagnosis".
2. Start the diagnosis and select "Upload Log > Copy the Log to Clipboard".
3. Paste the log anywhere and find the line beginning with "Region code:".
4. Look for the following codes: "AY" for China, "AZ" for the West US, "EU" for Central Europe, and "IN" for India.

Then manually specify endpoint in the plugin config.


#### What is "Standard DP" and "Non-standard DP"?

<!-- If your device is working properly, you don't need to know this. -->

"Standard DP" refers to device properties or functionalities that are specified in the Tuya IoT Development Platform documentation at [Tuya IoT Development Platform Documentation > Cloud Development > Standard Instruction Set](https://developer.tuya.com/en/docs/iot/standarddescription?id=K9i5ql6waswzq).

For example, a light bulb should have a standard DP code of `switch_led` for power on/off, and optional codes `bright_value`/`bright_value_v2` for brightness, `temp_value`/`temp_value_v2` for color temperature, and `work_mode` for changing the working mode. These codes can be found in the above documentation.

If your light bulb can be adjusted in the Tuya app but not with the plugin, it most likely has "Non-standard DP."


#### Can "Non-standard DP" be supportd by this plugin?

Yes. The device must be listed in the support list and the following steps must be completed before it will work:
1. Change the device's control mode on the Tuya Platform:
  - Go to "[Tuya Platform Cloud Development](https://iot.tuya.com/cloud/) > Your Project > Devices > All Devices > View Devices by Product".
  - Find the product related to your device, click the "pencil" icon (Change Control Instruction Mode).
  - <img width="500" alt="image" src="https://user-images.githubusercontent.com/5144674/202967707-8b934e05-36d6-4b42-bb7b-87e5b24474c4.png">
  - In the "Table of Instructions", you can see the cloud mapping and determine which DP codes are missing and need to be manually mapped later.
  - <img width="500" alt="image" src="https://user-images.githubusercontent.com/5144674/202967528-4838f9a1-0547-4102-afbb-180dc9b198b1.png">
  - Select "DP Instruction" and save.
2. Override the device schema, see [ADVANCED_OPTIONS.md](./ADVANCED_OPTIONS.md).


#### Local support
See [#90](https://github.com/homebridge-plugins/homebridge-tuya/issues/90).

Although the plugin didn't implemented tuya local protocol now, it still remains possibility in the future.


## Troubleshooting

If your device is not supported, please follow these steps to collect information.

#### 1. Get Device Information

After Homebridge has been successfully launched, the device information list will be saved in Homebridge's persist path. You can find the file path in the Homebridge log:

New device-list exports omit local device keys, IP addresses and coordinates, redact other recognised credentials, and use owner-only file permissions. The next startup replaces an older export with a sanitised private file. Older exports and logs are not retroactively sanitised. Homebridge's `config.json` also contains account credentials; its permissions are managed by the Homebridge installation and should restrict access to the account running Homebridge.
```
[2022/11/3 18:37:43] [TuyaPlatform] Device list saved at /path/to/TuyaDeviceList.{uid}.json
```

**⚠️Please make sure to remove sensitive information such as `ip`, `lon`, `lat`, `local_key`, and `uid` before submitting the file.**


#### 2. Enable Debug Mode

Add debug option in the plugin config, then restart Homebridge.

#### 3. Collect Logs

With debug mode enabled, you can now receive MQTT logs. Operate your device, either physically or through the Tuya App, to receive MQTT logs like this:

```
[2022/12/8 12:51:59] [TuyaPlatform] [TuyaOpenMQ] onMessage:
topic = cloud/token/in/xxx
protocol = 4
message = {
  "dataId": "xxx",
  "devId": "xxx",
  "productKey": "xxx",
  "status": [
    {
      "1": "double_click",
      "code": "switch1_value",
      "t": "1670475119766",
      "value": "double_click"
    }
  ]
}
```

If you are unable to receive any MQTT logs while controlling the device, it likely means that your device has "Non-standard DP".

By submitting the device information JSON and MQTT logs, you can help us support new device categories.


## Branches and upstream contributions

| Branch | Purpose | Upstream PR base |
| --- | --- | --- |
| `main` | Combined build: temperatures, security fixes and fork-specific scheduling | Maintained in this fork |
| `fix/security-hardening` | Credential handling, private diagnostic files, lock cancellation and dependency updates | `homebridge-plugins/homebridge-tuya:latest` |
| `fix/fastwarm-room-temperature` | Measured temperature and native target reporting for FastWarm thermostats | `homebridge-plugins/homebridge-tuya:latest` |
| `feat/fastwarm-native-schedules` | Scheduling development and investigation history | Maintained in this fork |

To propose a fix upstream, use **Compare across forks** on the original
repository. Select its `latest` branch as the base and the relevant `jdipper` fix
branch as the head. Those branches contain no scheduling changes and remain
independent of one another. GitHub compares the selected branches; the fork's
default branch does not determine the PR contents.

Make any reviewer-requested changes on the relevant fix branch, then merge that
branch back into `main`. The scheduling editor, household controls and related
runtime are maintained here and are not intended for the upstream PRs.

### Development checks

```sh
npm ci
npm run lint
npm run build
npm test -- --runInBand --watchman=false --testPathIgnorePatterns test/home.test.ts test/custom.test.ts
```

The excluded `home` and `custom` suites use a real Tuya account; the command above
runs the offline test suite. Live investigations under `tools/` are separate from
the ordinary tests and can issue real device commands when explicitly enabled.

For general plugin development, see the
[Homebridge development guide](https://github.com/homebridge/homebridge-plugin-template#setup-development-environment).

## Attribution

The broad Tuya device support and original configuration documentation come from
[homebridge-plugins/homebridge-tuya](https://github.com/homebridge-plugins/homebridge-tuya),
originally forked from `0x5e/homebridge-tuya-platform`. Upstream's published npm
package and Homebridge verification apply to that project. Support its maintainer
through [tassy-h's GitHub Sponsors page](https://github.com/sponsors/tassy-h).
