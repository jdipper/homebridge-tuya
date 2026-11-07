import TuyaDevice from './TuyaDevice';
import TuyaDeviceManager from './TuyaDeviceManager';
import { isFastWarmThermostat } from './profile/FastWarmThermostat';

interface DeviceRoom { homeID: string; roomID: string; name: string }

export default class TuyaHomeDeviceManager extends TuyaDeviceManager {

  private roomAssignments = new Map<string, DeviceRoom>();
  private roomRefresh?: Promise<void>;

  async getHomeList() {
    const res = await this.api.get(`/v1.0/users/${this.api.tokenInfo.uid}/homes`);
    return res;
  }

  async getHomeDeviceList(homeID: number) {
    const res = await this.api.get(`/v1.0/homes/${homeID}/devices`);
    return res;
  }

  async getHomeRoomList(homeID: string, timeoutMs = 5000) {
    return this.api.request('get', `/v1.0/homes/${homeID}/rooms`, null, null, { attempts: 1, timeoutMs });
  }

  async getRoomDeviceList(homeID: string, roomID: string, timeoutMs = 5000) {
    return this.api.request('get', `/v1.0/homes/${homeID}/rooms/${roomID}/devices`, null, null, { attempts: 1, timeoutMs });
  }

  /** Read room membership using the existing login; never rename or move a cloud device. */
  refreshDeviceRooms(): Promise<void> {
    if (!this.roomRefresh) {
      this.roomRefresh = this.readDeviceRooms().finally(() => {
        this.roomRefresh = undefined;
      });
    }
    return this.roomRefresh;
  }

  private async readDeviceRooms(): Promise<void> {
    const deadline = Date.now() + 12000;
    const timeout = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Room refresh deadline expired.');
      }
      return Math.min(5000, remaining);
    };
    const homeIDs = [...new Set(this.devices.filter(isFastWarmThermostat).map(device => device.owner_id))];
    for (const homeID of homeIDs) {
      if (typeof homeID !== 'string' || !/^\d+$/.test(homeID)) {
        continue;
      }
      const devices = this.devices.filter(device => device.owner_id === homeID && isFastWarmThermostat(device));
      const deviceIDs = new Set(devices.map(device => device.id));
      try {
        const res = await this.getHomeRoomList(homeID, timeout());
        if (res.success !== true || !Array.isArray(res.result?.rooms)) {
          throw new Error('Room list unavailable.');
        }
        const assignments = new Map<string, DeviceRoom>();
        for (const room of res.result.rooms) {
          const roomID = String(room?.room_id ?? '');
          if (!/^\d+$/.test(roomID) || typeof room.name !== 'string' || !room.name.trim()) {
            throw new Error('Invalid room metadata.');
          }
          const membership = await this.getRoomDeviceList(homeID, roomID, timeout());
          if (membership.success !== true || !Array.isArray(membership.result)) {
            throw new Error('Room membership unavailable.');
          }
          for (const member of membership.result) {
            if (!deviceIDs.has(member?.id)) {
              continue;
            }
            const previous = assignments.get(member.id);
            if (previous && previous.roomID !== roomID) {
              throw new Error('Conflicting room membership.');
            }
            assignments.set(member.id, { homeID, roomID, name: room.name.trim() });
          }
        }
        // Commit a complete home together: an interrupted read cannot erase cached names.
        for (const device of devices) {
          const room = assignments.get(device.id);
          if (room) {
            this.roomAssignments.set(device.id, room);
          } else {
            this.roomAssignments.delete(device.id);
          }
          this.enrichDeviceRoom(device);
          this.emit(TuyaDeviceManager.Events.DEVICE_INFO_UPDATE, device);
        }
      } catch {
        this.log.warn('Could not refresh SmartLife thermostat rooms. Keeping previously read room names.');
        for (const device of devices) {
          this.enrichDeviceRoom(device);
        }
      }
    }
  }

  protected enrichDeviceRoom(device: TuyaDevice): void {
    const room = this.roomAssignments.get(device.id);
    device.room_id = room?.homeID === device.owner_id ? room.roomID : undefined;
    device.room_name = room?.homeID === device.owner_id ? room.name : undefined;
  }

  async updateDevices(homeIDList: number[]) {

    let devices: TuyaDevice[] = [];
    for (const homeID of homeIDList) {
      const res = await this.getHomeDeviceList(homeID);
      devices = devices.concat((res.result as []).map(obj => new TuyaDevice(obj)));
    }
    if (devices.length === 0) {
      return [];
    }

    for (const device of devices) {
      device.schema = await this.getDeviceSchema(device.id);
      await this.enrichDeviceStatus(device);
    }

    // this.log.debug('Devices updated.\n', JSON.stringify(devices, null, 2));
    this.devices = devices;
    await this.refreshDeviceRooms();
    return devices;
  }

  async getSceneList(homeID: number) {
    const res = await this.api.get(`/v1.1/homes/${homeID}/scenes`);
    if (res.success === false) {
      this.log.warn('Get scene list failed. homeId = %d, code = %s, msg = %s', homeID, res.code, res.msg);
      return [];
    }

    const scenes: TuyaDevice[] = [];
    for (const { scene_id, name, enabled, status } of res.result) {
      if (enabled !== true || status !== '1') {
        continue;
      }

      scenes.push(new TuyaDevice({
        id: scene_id,
        uuid: scene_id,
        name,
        owner_id: homeID.toString(),
        product_id: 'scene',
        category: 'scene',
        schema: [],
        status: [],
        online: true,
      }));
    }
    return scenes;
  }

  async executeScene(homeID: string | number, sceneID: string) {
    const res = await this.api.post(`/v1.0/homes/${homeID}/scenes/${sceneID}/trigger`);
    return res;
  }
}
