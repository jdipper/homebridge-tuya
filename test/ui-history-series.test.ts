export {};

interface Report {
  at: number;
  sourceAt?: number;
  online: boolean;
  currentTemperature?: number;
  targetTemperature?: number;
}

interface ChartPoint { at: number; temperature: number }
interface ChartSeries {
  reports: (Report & { plotAt: number })[];
  currentTemperature: ChartPoint[][];
  targetTemperature: ChartPoint[][];
}

// Import the same pure preparation used by the browser chart, without a DOM or runtime.
const { buildTemperatureHistorySeries } = require('../homebridge-ui/public/schedule.js') as {
  buildTemperatureHistorySeries: (reports: Report[]) => ChartSeries;
};
const minute = 60000;

describe('temperature history chart report semantics', () => {
  test('interleaved target-only and measured-only reports do not create gaps or observations in the other series', () => {
    const result = buildTemperatureHistorySeries([
      { at: 0, online: true, currentTemperature: 18 },
      { at: minute, online: true, targetTemperature: 20 },
      { at: 5 * minute, online: true, currentTemperature: 18.5 },
      { at: 6 * minute, online: true, targetTemperature: 17 },
      { at: 10 * minute, online: true, currentTemperature: 19 },
    ]);
    expect(result.currentTemperature).toEqual([[
      { at: 0, temperature: 18 }, { at: 5 * minute, temperature: 18.5 }, { at: 10 * minute, temperature: 19 },
    ]]);
    expect(result.targetTemperature).toEqual([[
      { at: minute, temperature: 20 }, { at: 6 * minute, temperature: 17 },
    ]]);
  });

  test('positions and sorts observations at their source measurement time, falling back to reception time', () => {
    const result = buildTemperatureHistorySeries([
      { at: 10 * minute, sourceAt: 8 * minute, online: true, currentTemperature: 19 },
      { at: 11 * minute, sourceAt: 2 * minute, online: true, currentTemperature: 18 },
      { at: 12 * minute, online: true, currentTemperature: 20 },
    ]);
    expect(result.currentTemperature).toEqual([[
      { at: 2 * minute, temperature: 18 }, { at: 8 * minute, temperature: 19 }, { at: 12 * minute, temperature: 20 },
    ]]);
    expect(result.reports.map(report => report.plotAt)).toEqual([2 * minute, 8 * minute, 12 * minute]);
  });

  test('offline events break both series even when the next report belongs to a different property', () => {
    const result = buildTemperatureHistorySeries([
      { at: 0, online: true, currentTemperature: 18, targetTemperature: 20 },
      { at: minute, online: false },
      { at: 2 * minute, online: true },
      { at: 3 * minute, online: true, targetTemperature: 17 },
      { at: 4 * minute, online: true, currentTemperature: 19 },
    ]);
    expect(result.currentTemperature).toEqual([[{ at: 0, temperature: 18 }], [{ at: 4 * minute, temperature: 19 }]]);
    expect(result.targetTemperature).toEqual([[{ at: 0, temperature: 20 }], [{ at: 3 * minute, temperature: 17 }]]);
  });

  test('measured gaps use the time between measured reports, unaffected by intervening target reports', () => {
    const result = buildTemperatureHistorySeries([
      { at: 0, online: true, currentTemperature: 18, targetTemperature: 20 },
      { at: 25 * minute, online: true, targetTemperature: 19 },
      { at: 40 * minute, online: true, currentTemperature: 19 },
      { at: 45 * minute, online: true, targetTemperature: 17 },
    ]);
    expect(result.currentTemperature).toHaveLength(2);
    expect(result.targetTemperature).toHaveLength(1);
  });

  test('a stable reported target can span hours while online, and neither series extends after its own final report', () => {
    const result = buildTemperatureHistorySeries([
      { at: 0, online: true, targetTemperature: 20 },
      { at: 2 * 60 * minute, online: true, targetTemperature: 17 },
      { at: 2 * 60 * minute + minute, online: true, currentTemperature: 18 },
      { at: 2 * 60 * minute + 5 * minute, online: true },
    ]);
    expect(result.targetTemperature).toEqual([[
      { at: 0, temperature: 20 }, { at: 2 * 60 * minute, temperature: 17 },
    ]]);
    expect(result.currentTemperature).toEqual([[{ at: 2 * 60 * minute + minute, temperature: 18 }]]);
  });

  test('does not mutate the history supplied by the runtime', () => {
    const reports: Report[] = [
      { at: 2 * minute, online: true, currentTemperature: 19 },
      { at: minute, online: true, currentTemperature: 18 },
    ];
    const saved = JSON.stringify(reports);
    buildTemperatureHistorySeries(reports);
    expect(JSON.stringify(reports)).toBe(saved);
  });
});
