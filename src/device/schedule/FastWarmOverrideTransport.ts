import TuyaOpenAPI from '../../core/TuyaOpenAPI';
import TuyaDevice from '../TuyaDevice';
import { isFastWarmThermostat } from '../profile/FastWarmThermostat';

export interface FastWarmOverrideBaseline {
  mode: 'smart';
  temperature: number;
  power: true;
  unit: 'c';
}

interface OverrideReading {
  mode: string;
  temperature: number;
  power: boolean;
  unit: 'c';
}

/** Explicit host-timed Hold. No device countdown capability is assumed. */
export default class FastWarmOverrideTransport {
  constructor(private api: TuyaOpenAPI, private getDevice: (id: string) => TuyaDevice | undefined) {}

  async preview(id: string): Promise<FastWarmOverrideBaseline> {
    this.requireVerifiedActivation();
    const reading = await this.read(id);
    if (!reading.power || reading.mode !== 'smart') {
      throw new Error('Temporary overrides require an online, powered-on thermostat in Scheduled mode.');
    }
    return { ...reading, mode: 'smart', power: true };
  }

  async startOverride(id: string, request: {
    temperature: number; endsAt: number; baseline: FastWarmOverrideBaseline;
  }): Promise<void> {
    // Also reject previously issued previews: disabling the editor alone cannot prevent activation.
    this.requireVerifiedActivation();
    this.validateTemperature(request.temperature);
    if (!Number.isSafeInteger(request.endsAt) || request.endsAt <= Date.now() || request.endsAt > Date.now() + 24 * 60 * 60_000) {
      throw new Error('Choose an override ending within the next 24 hours.');
    }
    const current = await this.preview(id);
    if (!request.baseline || current.mode !== request.baseline.mode || current.power !== request.baseline.power
      || current.unit !== request.baseline.unit || current.temperature !== request.baseline.temperature) {
      throw new Error('The thermostat changed after preview. Preview the override again.');
    }
    await this.issue(id, { SetTemp: Math.round(request.temperature * 10), ControlMode: 'hold' });
    const result = await this.read(id);
    if (!result.power || result.mode !== 'hold' || result.temperature !== request.temperature) {
      throw new Error('The temporary override could not be confirmed. Read the thermostat before retrying.');
    }
  }

  async resumeOverride(id: string, request: { temperature: number; baseline: FastWarmOverrideBaseline }): Promise<void> {
    this.validateTemperature(request.temperature);
    const current = await this.read(id);
    if (current.mode === 'smart' && current.power) {
      // A manual resume or a previously acknowledged resume already reached scheduled mode.
      return;
    }
    if (!current.power || current.mode !== 'hold' || current.temperature !== request.temperature) {
      throw new Error('The thermostat was changed outside this override. Review it before resuming a programme.');
    }
    if (request.baseline.mode !== 'smart' || request.baseline.unit !== 'c' || request.baseline.power !== true) {
      throw new Error('The original scheduled mode could not be established.');
    }
    await this.issue(id, { ControlMode: 'smart' });
    const result = await this.read(id);
    if (!result.power || result.mode !== 'smart') {
      throw new Error('Scheduled mode could not be confirmed. The override may still be active.');
    }
  }

  private validateTemperature(temperature: number) {
    if (!Number.isFinite(temperature) || temperature < 5 || temperature > 40 || !Number.isInteger(temperature * 2)) {
      throw new Error('Choose a temperature from 5–40°C in 0.5°C steps.');
    }
  }

  private requireVerifiedActivation() {
    // The live combined target/Hold command restored a different stored Hold temperature.
    // Keep activation unavailable until a separate, explicitly authorized protocol is verified on hardware.
    throw new Error('Temporary temperature overrides are unavailable until FastWarm Hold and setpoint transitions are verified. '
      + 'No command was sent.');
  }

  private requireDevice(id: string) {
    const device = this.getDevice(id);
    if (!device || !isFastWarmThermostat(device) || !device.online
      || device.status.find(item => item.code === 'temp_unit_convert')?.value !== 'c') {
      throw new Error('The supported thermostat must be online and configured in Celsius.');
    }
  }

  private async read(id: string): Promise<OverrideReading> {
    this.requireDevice(id);
    const response = await this.api.request('get', `/v2.0/cloud/thing/${id}/shadow/properties`, {
      codes: 'ControlMode,SetTemp,power1,TemperUnitChange',
    }, null, { attempts: 1, timeoutMs: 10_000 });
    if (response.success !== true || !Array.isArray(response.result?.properties)) {
      throw new Error('Could not read the thermostat before changing its override.');
    }
    const properties = response.result.properties as { code: string; value: unknown }[];
    const get = (code: string) => properties.find(item => item.code === code)?.value;
    const mode = get('ControlMode');
    const target = get('SetTemp');
    // This product's native DP101 is power1, distinct from standardized switch/power codes.
    const power = get('power1');
    // DP107 false=C has been verified for this product; do not trust a stale standard-unit cache alone.
    if (get('TemperUnitChange') !== false || typeof mode !== 'string' || !['smart', 'holiday', 'hold'].includes(mode)
      || typeof target !== 'number' || !Number.isInteger(target) || (power !== true && power !== false && power !== 0 && power !== 1)) {
      throw new Error('The thermostat did not report verified Celsius, power, mode and target properties.');
    }
    this.validateTemperature(target / 10);
    return { mode, temperature: target / 10, power: power === true || power === 1, unit: 'c' };
  }

  private async issue(id: string, properties: Record<string, string | number>) {
    this.requireDevice(id);
    const response = await this.api.postOnce(`/v2.0/cloud/thing/${id}/shadow/properties/issue`, {
      properties: JSON.stringify(properties),
    }, { timeoutMs: 15_000 });
    if (response.success !== true) {
      throw new Error(`The thermostat rejected the override command: ${response.code ?? 'unknown'} ${response.msg ?? ''}`);
    }
  }
}
