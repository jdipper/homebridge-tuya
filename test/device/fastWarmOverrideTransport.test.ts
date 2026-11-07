import TuyaOpenAPI from '../../src/core/TuyaOpenAPI';
import TuyaDevice from '../../src/device/TuyaDevice';
import FastWarmOverrideTransport, { FastWarmOverrideBaseline } from '../../src/device/schedule/FastWarmOverrideTransport';
import { initLogger } from '../../src/util/Logger';

const NOW = Date.parse('2026-11-07T10:00:00Z');
const baseline: FastWarmOverrideBaseline = { mode: 'smart', temperature: 20, power: true, unit: 'c' };
const shadow = (mode = 'smart', temperature = 20, power: number | boolean = true, unit = false) => ({
  success: true as const, t: NOW, tid: 'test', result: { properties: [
    { code: 'ControlMode', value: mode }, { code: 'SetTemp', value: temperature * 10 },
    { code: 'power1', dp_id: 101, type: 'bool', value: power }, { code: 'TemperUnitChange', value: unit },
  ] },
});

describe('explicit FastWarm host-timed overrides', () => {
  let device: TuyaDevice;
  let api: TuyaOpenAPI;
  let transport: FastWarmOverrideTransport;
  let read: jest.SpyInstance;
  let write: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    initLogger({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() });
    device = new TuyaDevice({ id: 'room', product_id: 'lmtejj3f4kafi2k1', online: true,
      status: [{ code: 'temp_unit_convert', value: 'c' }], schema: [] });
    api = new TuyaOpenAPI(TuyaOpenAPI.Endpoints.EUROPE, 'test', 'test');
    read = jest.spyOn(api, 'request').mockResolvedValue(shadow());
    write = jest.spyOn(api, 'postOnce').mockResolvedValue({ success: true, result: {}, t: NOW, tid: 'test' });
    transport = new FastWarmOverrideTransport(api, id => id === device.id ? device : undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('preview reads native controls with a deadline, without any command', async () => {
    expect(await transport.preview('room')).toEqual(baseline);
    expect(read).toHaveBeenCalledWith('get', '/v2.0/cloud/thing/room/shadow/properties',
      { codes: 'ControlMode,SetTemp,power1,TemperUnitChange' }, null, { attempts: 1, timeoutMs: 10000 });
    expect(write).not.toHaveBeenCalled();
  });

  test('requires the verified native power1 property rather than an unverified power alias', async () => {
    const response = shadow();
    const property = response.result.properties.find(item => item.code === 'power1')!;
    property.code = 'power';
    read.mockResolvedValue(response);
    await expect(transport.preview('room')).rejects.toThrow(/verified Celsius, power, mode and target/);
    expect(write).not.toHaveBeenCalled();
  });

  test('writes only target and Hold once, then verifies both using fresh properties', async () => {
    read.mockResolvedValueOnce(shadow()).mockResolvedValueOnce(shadow('hold', 22.5));
    await transport.startOverride('room', { temperature: 22.5, endsAt: NOW + 3600000, baseline });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][1].properties)).toEqual({ SetTemp: 225, ControlMode: 'hold' });
    expect(write.mock.calls[0][2]).toEqual({ timeoutMs: 15000 });
  });

  test.each([NaN, 4.5, 40.5, 20.1])('rejects invalid temperature %s before any cloud request', async temperature => {
    await expect(transport.startOverride('room', { temperature, endsAt: NOW + 3600000, baseline })).rejects.toThrow(/temperature/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test.each([NOW, NOW - 1, NOW + 25 * 3600000])('rejects expired or excessive deadline %s', async endsAt => {
    await expect(transport.startOverride('room', { temperature: 22, endsAt, baseline })).rejects.toThrow(/24 hours/);
    expect(write).not.toHaveBeenCalled();
  });

  test.each([['hold', 20, 1, false], ['smart', 20, 0, false], ['smart', 20, 1, true]])(
    'does not start from unsupported baseline %s/%s/%s/%s', async (mode, target, power, unit) => {
      read.mockResolvedValue(shadow(mode as string, target as number, power as number, unit as boolean));
      await expect(transport.startOverride('room', { temperature: 22, endsAt: NOW + 3600000, baseline })).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    });

  test('a concurrent manual target change invalidates the preview', async () => {
    read.mockResolvedValue(shadow('smart', 18));
    await expect(transport.startOverride('room', { temperature: 22, endsAt: NOW + 3600000, baseline }))
      .rejects.toThrow(/changed after preview/);
    expect(write).not.toHaveBeenCalled();
  });

  test('an acknowledged command without matching readback is not reported successful', async () => {
    await expect(transport.startOverride('room', { temperature: 22, endsAt: NOW + 3600000, baseline })).rejects.toThrow(/not be confirmed/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('a rejected or uncertain command is never retried', async () => {
    write.mockRejectedValue(new Error('connection lost'));
    await expect(transport.startOverride('room', { temperature: 22, endsAt: NOW + 3600000, baseline })).rejects.toThrow(/connection lost/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('resume only changes mode after confirming the override still owns the target', async () => {
    read.mockResolvedValueOnce(shadow('hold', 22)).mockResolvedValueOnce(shadow('smart', 20));
    await transport.resumeOverride('room', { temperature: 22, baseline });
    expect(JSON.parse(write.mock.calls[0][1].properties)).toEqual({ ControlMode: 'smart' });
  });

  test.each([['hold', 23], ['holiday', 22]])('resume respects an external change %s/%s', async (mode, target) => {
    read.mockResolvedValue(shadow(mode as string, target as number));
    await expect(transport.resumeOverride('room', { temperature: 22, baseline })).rejects.toThrow(/outside this override/);
    expect(write).not.toHaveBeenCalled();
  });

  test('an external resume already in Scheduled mode does not issue another command', async () => {
    await transport.resumeOverride('room', { temperature: 22, baseline });
    expect(write).not.toHaveBeenCalled();
  });

  test('unrelated products and offline devices are rejected', async () => {
    device.online = false;
    await expect(transport.preview('room')).rejects.toThrow(/online/);
    device.online = true;
    device.product_id = 'unverified';
    await expect(transport.preview('room')).rejects.toThrow(/supported/);
    expect(read).not.toHaveBeenCalled();
  });
});
