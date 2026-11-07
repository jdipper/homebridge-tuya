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

describe('FastWarm override activation gate and explicit recovery', () => {
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

  test('preview is unavailable without making any cloud read or write', async () => {
    await expect(transport.preview('room')).rejects.toThrow(/unavailable.*No command was sent/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test('start independently rejects previously issued previews without any cloud read or write', async () => {
    await expect(transport.startOverride('room', { temperature: 20.5, endsAt: NOW + 60000, baseline }))
      .rejects.toThrow(/unavailable.*No command was sent/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test('explicit resume remains available and only changes mode after confirming ownership', async () => {
    read.mockResolvedValueOnce(shadow('hold', 22)).mockResolvedValueOnce(shadow('smart', 20));
    await transport.resumeOverride('room', { temperature: 22, baseline });
    expect(read).toHaveBeenCalledWith('get', '/v2.0/cloud/thing/room/shadow/properties',
      { codes: 'ControlMode,SetTemp,power1,TemperUnitChange' }, null, { attempts: 1, timeoutMs: 10000 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][1].properties)).toEqual({ ControlMode: 'smart' });
    expect(write.mock.calls[0][2]).toEqual({ timeoutMs: 15000 });
  });

  test('requires the verified native power1 property rather than an unverified power alias', async () => {
    const response = shadow('hold', 22);
    const property = response.result.properties.find(item => item.code === 'power1')!;
    property.code = 'power';
    read.mockResolvedValue(response);
    await expect(transport.resumeOverride('room', { temperature: 22, baseline }))
      .rejects.toThrow(/verified Celsius, power, mode and target/);
    expect(write).not.toHaveBeenCalled();
  });

  test('the observed combined-write result is not treated as ownership of the requested 20.5°C target', async () => {
    // Live 7 November 2026: {SetTemp:205, ControlMode:'hold'} acknowledged, then reported Hold at 22°C.
    // Activation remains gated; this fixture preserves the hardware outcome rather than assuming atomic application.
    read.mockResolvedValue(shadow('hold', 22));
    await expect(transport.resumeOverride('room', { temperature: 20.5, baseline }))
      .rejects.toThrow(/outside this override/);
    expect(write).not.toHaveBeenCalled();
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

  test('a rejected or uncertain resume is never retried', async () => {
    read.mockResolvedValue(shadow('hold', 22));
    write.mockRejectedValue(new Error('connection lost'));
    await expect(transport.resumeOverride('room', { temperature: 22, baseline })).rejects.toThrow(/connection lost/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('an acknowledged resume without matching readback is not reported successful', async () => {
    read.mockResolvedValue(shadow('hold', 22));
    await expect(transport.resumeOverride('room', { temperature: 22, baseline })).rejects.toThrow(/could not be confirmed/);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test.each([[0, false], [1, true]])('resume rejects powered-off or Fahrenheit state %s/%s', async (power, unit) => {
    read.mockResolvedValue(shadow('hold', 22, power as number, unit as boolean));
    await expect(transport.resumeOverride('room', { temperature: 22, baseline })).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  test('recovery on unrelated products and offline devices is rejected without a cloud call', async () => {
    device.online = false;
    await expect(transport.resumeOverride('room', { temperature: 22, baseline })).rejects.toThrow(/online/);
    device.online = true;
    device.product_id = 'unverified';
    await expect(transport.resumeOverride('room', { temperature: 22, baseline })).rejects.toThrow(/supported/);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
