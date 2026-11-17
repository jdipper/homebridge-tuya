import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import TuyaOpenAPI from '../../src/core/TuyaOpenAPI';
import TuyaDevice, { TuyaDeviceSchemaMode, TuyaDeviceSchemaType } from '../../src/device/TuyaDevice';
import TuyaDeviceManager from '../../src/device/TuyaDeviceManager';
import { FastWarmLanError, isFastWarmLanCommand } from '../../src/device/lan/FastWarmLanClient';
import {
  FastWarmLanCommandOptions, FastWarmLanConnectionListener, FastWarmLanProperty, FastWarmLanRawListener,
  FastWarmLanScheduleRead, FastWarmLanTransport,
} from '../../src/device/lan/FastWarmLanTransport';
import { initLogger } from '../../src/util/Logger';

const ID = 'local-thermostat', NOW = Date.parse('2026-11-17T20:00:00Z');
const DP: Record<string, number> = {
  power1: 101, SetTemp: 102, ControlMode: 103, RoomTemper: 105, FloorTemper: 106,
  TemperUnitChange: 107, Lock: 108, Event_Adaptive_Set: 110, week_program: 119, inquire: 122,
};
const BASE: Record<string, string | number | boolean> = {
  power1: true, SetTemp: 180, ControlMode: 'smart', RoomTemper: 185, TemperUnitChange: false, Lock: false, Event_Adaptive_Set: 0,
};

class FakeLan extends EventEmitter implements FastWarmLanTransport {
  connected = true;
  epoch = 1;
  readonly raw = new Set<FastWarmLanRawListener>();
  readonly connections = new Set<FastWarmLanConnectionListener>();
  values = {...BASE};
  reads: string[][] = [];
  issues: Record<string, string | number | boolean>[] = [];
  readScript: Partial<typeof BASE>[] = [];
  writeEffect: 'apply' | 'ignore' | 'uncertain' = 'apply';
  changeGenerationOnRead = 0;

  has(id: string): boolean { return id === ID; }
  isConnected(id: string): boolean { return this.has(id) && this.connected; }
  generation(): number { return this.epoch; }
  addRawMessageListener(listener: FastWarmLanRawListener): void { this.raw.add(listener); }
  removeRawMessageListener(listener: FastWarmLanRawListener): void { this.raw.delete(listener); }
  addConnectionListener(listener: FastWarmLanConnectionListener): void { this.connections.add(listener); }
  removeConnectionListener(listener: FastWarmLanConnectionListener): void { this.connections.delete(listener); }

  emitNative(values: Record<string, unknown>, receivedAt = Date.now(), id = ID): void {
    const status: FastWarmLanProperty[] = Object.entries(values).map(([code, value]) => ({code, dp_id: DP[code], value}));
    for (const listener of this.raw) {
      listener('fastwarm/lan', 4, {devId: id, status, source: 'lan'}, receivedAt);
    }
  }

  connection(connected: boolean): void {
    this.connected = connected;
    this.epoch++;
    for (const listener of this.connections) {
      listener({deviceId: ID, connected, generation: this.epoch});
    }
  }

  async readProperties(id: string, codes: string[], options: FastWarmLanCommandOptions = {}) {
    if (!this.isConnected(id) || options.shouldProceed?.() === false) {
      throw new FastWarmLanError('unavailable');
    }
    this.reads.push([...codes]);
    Object.assign(this.values, this.readScript.shift());
    if (this.changeGenerationOnRead === this.reads.length) {
      this.epoch++;
    }
    this.emitNative(this.values);
    return {properties: codes.map(code => ({code, dp_id: DP[code], value: this.values[code]})), receivedAt: Date.now(), generation: this.epoch};
  }

  async issueOnce(id: string, properties: Record<string, string | number | boolean>, options: FastWarmLanCommandOptions = {}) {
    if (!this.isConnected(id) || options.shouldProceed?.() === false) {
      throw new FastWarmLanError('unavailable');
    }
    const dps = Object.fromEntries(Object.entries(properties).map(([code, value]) => [String(DP[code]), value]));
    if (!isFastWarmLanCommand(dps)) {
      throw new FastWarmLanError('invalid-command');
    }
    this.issues.push({...properties});
    if (this.writeEffect !== 'ignore') {
      Object.assign(this.values, properties);
      this.emitNative(this.values);
    }
    if (this.writeEffect === 'uncertain') {
      throw new FastWarmLanError('timeout', true);
    }
  }

  async readSchedule(): Promise<FastWarmLanScheduleRead> { throw new Error('Unexpected programme read'); }
  close(): void { this.connection(false); }
}

function device(id = ID): TuyaDevice {
  return new TuyaDevice({
    id, name: 'Test room', product_id: 'lmtejj3f4kafi2k1', online: true,
    schema: [{code: 'temp_set', mode: TuyaDeviceSchemaMode.READ_WRITE, type: TuyaDeviceSchemaType.Integer,
      property: {min: 41, max: 1040, scale: 1, step: 1, unit: ''}}],
    status: [{code: 'switch', value: true}, {code: 'temp_set', value: 180}, {code: 'temp_unit_convert', value: 'c'},
      {code: 'mode', value: 'smart'}, {code: 'child_lock', value: false}],
  });
}

describe('device manager selected FastWarm LAN ownership', () => {
  let api: TuyaOpenAPI, manager: TuyaDeviceManager, thermostat: TuyaDevice, local: FakeLan;
  const status = (code: string) => thermostat.status.find(item => item.code === code)?.value;
  const cloudCalls = () => {
    expect(api.request).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    initLogger({info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn()});
    api = new TuyaOpenAPI(TuyaOpenAPI.Endpoints.EUROPE, 'test-access-id', 'test-api-key');
    for (const method of ['request', 'get', 'post'] as const) {
      jest.spyOn(api, method).mockRejectedValue(new Error('Unexpected cloud request'));
    }
    manager = new TuyaDeviceManager(api);
    thermostat = device();
    manager.devices = [thermostat];
    local = new FakeLan();
    manager.setFastWarmLan(local);
    await manager.enrichDeviceStatus(thermostat);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('adds a real measured-temperature schema without polling cloud or inventing an observation', async () => {
    expect(thermostat.schema.find(item => item.code === 'temp_current')).toMatchObject({
      mode: 'ro', type: 'Integer', property: {scale: 1},
    });
    expect(status('temp_current')).toBeUndefined();
    expect(manager.getTemperatureObservation(ID)).toBeUndefined();
    expect(manager.isTemperatureAvailable(ID)).toBe(false);
    cloudCalls();
  });

  test('keeps measured temperature, target, native mode, power and lock truthful from LAN reports', () => {
    local.emitNative({...BASE, RoomTemper: 190, SetTemp: 205, ControlMode: 'hold', Lock: true, power1: false});
    expect(status('temp_current')).toBe(190);
    expect(status('temp_set')).toBe(205);
    expect(status('mode')).toBe('hold');
    expect(status('switch')).toBe(false);
    expect(status('child_lock')).toBe(true);
    expect(manager.getTemperatureObservation(ID)).toMatchObject({value: 190, receivedAt: NOW, source: 'lan'});
    expect(manager.isTemperatureAvailable(ID)).toBe(true);
    cloudCalls();
  });

  test('preserves the wire receive time instead of assigning freshness when a report callback is delayed', () => {
    const receivedAt = NOW - 2000;
    local.emitNative(BASE, receivedAt);
    expect(manager.getTemperatureObservation(ID)).toMatchObject({receivedAt, source: 'lan', value: 185});
    expect(manager.getTemperatureObservation(ID)?.reportedAt).toBeUndefined();
    cloudCalls();
  });

  test('cache reads and rediscovery do not manufacture newer measurement timestamps', async () => {
    local.emitNative(BASE);
    const first = manager.getTemperatureObservation(ID);
    jest.setSystemTime(NOW + 30000);
    await manager.refreshSupplementalTemperature(thermostat);
    await manager.enrichDeviceStatus(thermostat);
    expect(manager.getTemperatureObservation(ID)).toEqual(first);
    expect(local.reads).toEqual([]);
    cloudCalls();
  });

  test('an unchanged genuine measurement still refreshes observation listeners', () => {
    local.emitNative(BASE);
    const callback = jest.fn();
    manager.on(TuyaDeviceManager.Events.THERMOSTAT_OBSERVATION, callback);
    jest.setSystemTime(NOW + 3000);
    local.emitNative({RoomTemper: 185});
    expect(callback).toHaveBeenCalledTimes(1);
    expect(manager.getTemperatureObservation(ID)).toMatchObject({value: 185, receivedAt: NOW + 3000, source: 'lan'});
    expect(status('temp_current')).toBe(185);
    cloudCalls();
  });

  test('cloud status and cloud online/offline messages cannot overwrite selected local truth', async () => {
    local.emitNative(BASE);
    const original = manager.getTemperatureObservation(ID);
    await manager.onMQTTMessage('cloud', 4, {devId: ID, status: [
      {code: 'temp_set', value: 350}, {code: 'temp_current', value: 350}, {code: 'switch', value: false},
      {code: 'RoomTemper', dp_id: 105, value: 350}, {code: 'ControlMode', dp_id: 103, value: 'holiday'},
    ]});
    await manager.onMQTTMessage('cloud', 20, {devId: ID, bizCode: 'offline', bizData: {}});
    expect(thermostat.online).toBe(true);
    expect(status('temp_set')).toBe(180);
    expect(status('temp_current')).toBe(185);
    expect(status('switch')).toBe(true);
    expect(status('mode')).toBe('smart');
    expect(manager.getTemperatureObservation(ID)).toEqual(original);
    local.connection(false);
    await manager.onMQTTMessage('cloud', 20, {devId: ID, bizCode: 'online', bizData: {}});
    expect(thermostat.online).toBe(false);
    expect(manager.isTemperatureAvailable(ID)).toBe(false);
    cloudCalls();
  });

  test('reconnection itself does not revive an old room measurement', () => {
    local.emitNative(BASE);
    const first = manager.getTemperatureObservation(ID);
    local.connection(false);
    local.connection(true);
    expect(manager.getTemperatureObservation(ID)).toEqual(first);
    expect(manager.isTemperatureAvailable(ID)).toBe(false);
    local.emitNative({RoomTemper: 185});
    expect(manager.isTemperatureAvailable(ID)).toBe(true);
    cloudCalls();
  });

  test('a Fahrenheit report is not interpreted as a Celsius room or target value', async () => {
    local.emitNative(BASE);
    local.emitNative({TemperUnitChange: true, RoomTemper: 680, SetTemp: 700});
    expect(status('temp_unit_convert')).toBe('f');
    expect(status('temp_current')).toBe(185);
    expect(status('temp_set')).toBe(180);
    expect(manager.isTemperatureAvailable(ID)).toBe(false);
    local.values.TemperUnitChange = true;
    await expect(manager.sendCommands(ID, [{code: 'temp_set', value: 185}])).rejects.toThrow('Celsius');
    expect(local.issues).toEqual([]);
    cloudCalls();
  });

  test('returning from Fahrenheit requires another genuine Celsius measurement', () => {
    local.emitNative(BASE);
    local.emitNative({TemperUnitChange: true});
    local.emitNative({TemperUnitChange: false});
    expect(manager.isTemperatureAvailable(ID)).toBe(false);
    local.emitNative({RoomTemper: 185});
    expect(manager.isTemperatureAvailable(ID)).toBe(true);
    cloudCalls();
  });

  test.each([
    {command: {code: 'temp_set', value: 185}, expected: {SetTemp: 185}},
    {command: {code: 'switch', value: false}, expected: {power1: false}},
    {command: {code: 'child_lock', value: true}, expected: {Lock: true}},
    {command: {code: 'mode', value: 'hold'}, expected: {ControlMode: 'hold'}},
  ])('writes and verifies an exact supported command over LAN only %j', async ({command, expected}) => {
    const operation = manager.sendCommands(ID, [command]);
    await jest.advanceTimersByTimeAsync(1100);
    await expect(operation).resolves.toBe(true);
    expect(local.issues).toEqual([expected]);
    expect(local.reads.length).toBeGreaterThanOrEqual(2);
    cloudCalls();
  });

  test('an unverified command has one dispatch and bounded readback only', async () => {
    local.writeEffect = 'ignore';
    const outcome = manager.sendCommands(ID, [{code: 'temp_set', value: 185}]).catch(error => error);
    await jest.advanceTimersByTimeAsync(3100);
    expect(await outcome).toEqual(expect.objectContaining({message: expect.stringContaining('Do not automatically retry')}));
    expect(local.issues).toEqual([{SetTemp: 185}]);
    expect(local.reads).toHaveLength(4);
    cloudCalls();
  });

  test('an uncertain transport outcome never retries the local write or falls back to cloud', async () => {
    local.writeEffect = 'uncertain';
    await expect(manager.sendCommands(ID, [{code: 'temp_set', value: 185}]))
      .rejects.toMatchObject({code: 'timeout', writeAttempted: true});
    expect(local.issues).toEqual([{SetTemp: 185}]);
    expect(local.reads).toHaveLength(1);
    cloudCalls();
  });

  test('a readback from another connection cannot confirm a command', async () => {
    local.changeGenerationOnRead = 2;
    const outcome = manager.sendCommands(ID, [{code: 'temp_set', value: 185}]).catch(error => error);
    await jest.advanceTimersByTimeAsync(1100);
    expect(await outcome).toEqual(expect.objectContaining({message: expect.stringContaining('Do not automatically retry')}));
    expect(local.issues).toEqual([{SetTemp: 185}]);
    cloudCalls();
  });

  test('a unit change after dispatch cannot falsely verify an equal raw target', async () => {
    local.readScript.push({TemperUnitChange: false}, {TemperUnitChange: true});
    const outcome = manager.sendCommands(ID, [{code: 'temp_set', value: 185}]).catch(error => error);
    await jest.advanceTimersByTimeAsync(3100);
    expect(await outcome).toBeInstanceOf(Error);
    expect(local.issues).toEqual([{SetTemp: 185}]);
    cloudCalls();
  });

  test('offline selected thermostats reject commands without touching either transport', async () => {
    local.connection(false);
    await expect(manager.sendCommands(ID, [{code: 'temp_set', value: 185}])).rejects.toThrow('unavailable');
    expect(local.issues).toEqual([]);
    expect(local.reads).toEqual([]);
    cloudCalls();
  });

  test.each([
    {code: 'mode', value: 'auto'}, {code: 'temp_set', value: 181}, {code: 'temp_set', value: 1040},
    {code: 'switch', value: 'false'}, {code: 'holiday_days_set', value: 7}, {code: 'factory_reset', value: true},
  ])('rejects unsupported values without guessing a native meaning or using cloud %j', async command => {
    await expect(manager.sendCommands(ID, [command])).rejects.toBeInstanceOf(Error);
    expect(local.issues).toEqual([]);
    cloudCalls();
  });

  test('keeps cloud control for thermostats not selected for LAN ownership', async () => {
    const other = device('cloud-thermostat');
    manager.devices.push(other);
    (api.post as jest.MockedFunction<TuyaOpenAPI['post']>).mockResolvedValue({success: true, result: true, t: NOW, tid: 'test'});
    await expect(manager.sendCommands(other.id, [{code: 'temp_set', value: 185}])).resolves.toBe(true);
    expect(api.post).toHaveBeenCalledWith('/v1.0/devices/cloud-thermostat/commands', {commands: [{code: 'temp_set', value: 185}]});
    expect(local.issues).toEqual([]);
  });

  test('one local owner cannot be replaced by a second connection manager', () => {
    expect(() => manager.setFastWarmLan(new FakeLan())).toThrow('already has an owner');
    cloudCalls();
  });
});
