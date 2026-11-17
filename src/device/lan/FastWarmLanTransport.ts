import type { FastWarmScheduleState } from '../schedule/FastWarmSchedule';

/** Native ET-63 reports; no local keys or transport configuration cross this interface. */
export interface FastWarmLanProperty {
  code: string;
  dp_id: number;
  value: unknown;
}

export interface FastWarmLanConnectionEvent {
  deviceId: string;
  connected: boolean;
  generation: number;
}

export type FastWarmLanRawListener = (topic: string, protocol: number,
  message: {devId: string; status: FastWarmLanProperty[]; source: 'lan'}, receivedAt: number) => void;
export type FastWarmLanConnectionListener = (event: FastWarmLanConnectionEvent) => void;

export interface FastWarmLanCommandOptions {
  shouldProceed?: () => boolean;
  timeoutMs?: number;
}

export interface FastWarmLanScheduleRead {
  startedAt: number;
  finishedAt: number;
  state: FastWarmScheduleState;
  fingerprint: string | null;
  timedOut: boolean;
  errors: string[];
}

/** Selected thermostats never fall back to a cloud write after an uncertain local dispatch. */
export interface FastWarmLanTransport {
  has(deviceId: string): boolean;
  isConnected(deviceId: string): boolean;
  generation(deviceId: string): number;
  readProperties(deviceId: string, codes: string[], options?: FastWarmLanCommandOptions): Promise<{
    properties: FastWarmLanProperty[]; receivedAt: number; generation: number;
  }>;
  readSchedule(deviceId: string, options?: FastWarmLanCommandOptions): Promise<FastWarmLanScheduleRead>;
  issueOnce(deviceId: string, properties: Record<string, string | number | boolean>,
    options?: FastWarmLanCommandOptions): Promise<void>;
  addRawMessageListener(listener: FastWarmLanRawListener): void;
  removeRawMessageListener(listener: FastWarmLanRawListener): void;
  addConnectionListener(listener: FastWarmLanConnectionListener): void;
  removeConnectionListener(listener: FastWarmLanConnectionListener): void;
  close(): void;
}
