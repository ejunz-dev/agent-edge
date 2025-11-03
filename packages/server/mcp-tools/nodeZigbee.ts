// @ts-nocheck
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';

const logger = new Logger('node-mcp-zigbee');

// 列出所有 Zigbee 设备
export const zigbeeListDevicesTool = {
    name: 'zigbee_list_devices',
    description: '列出所有可用的 Zigbee 设备（开关、插座等），返回设备的基本信息和标识符',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
};

export async function callZigbeeListDevicesTool(ctx: Context, args: any): Promise<any> {
    logger.info('[zigbee_list_devices] 开始列出设备');
    let devices: any[] = [];
    
    await ctx.inject(['zigbee'], async (c) => {
        const svc = c.zigbee;
        if (!svc) {
            throw new Error('Zigbee 服务未初始化');
        }
        devices = await svc.listDevices();
    });
    
    const result = {
        count: devices.length,
        devices: devices.map((d: any) => ({
            deviceId: d.ieee_address,
            friendlyName: d.friendly_name || d.ieee_address,
            model: d.definition?.model || '未知型号',
            vendor: d.definition?.vendor || '未知厂商',
            type: d.type === 'Router' ? '路由器' : (d.type === 'EndDevice' ? '终端设备' : d.type || '未知'),
            powerSource: d.powerSource,
            lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
            supportsOnOff: d.supportsOnOff,
        })),
    };
    
    logger.info('[zigbee_list_devices] 找到 %d 个设备', result.count);
    return result;
}

// 获取设备状态
export const zigbeeGetDeviceStatusTool = {
    name: 'zigbee_get_device_status',
    description: '获取指定 Zigbee 设备的当前状态（开关状态、在线状态等）',
    parameters: {
        type: 'object',
        properties: {
            deviceId: {
                type: 'string',
                description: '设备 IEEE 地址或友好名称，例如 "0xa4c1388b3518f6ce"',
            },
        },
        required: ['deviceId'],
    },
};

export async function callZigbeeGetDeviceStatusTool(ctx: Context, args: any): Promise<any> {
    const { deviceId } = args;
    
    logger.info('[zigbee_get_device_status] 查询设备状态: %s', deviceId);
    
    if (!deviceId) {
        throw new Error('缺少必要参数：deviceId');
    }
    
    let deviceInfo: any = null;
    let currentState: string | null = null;
    
    await ctx.inject(['zigbee'], async (c) => {
        const svc = c.zigbee;
        if (!svc) {
            throw new Error('Zigbee 服务未初始化');
        }
        
        // 获取设备列表以查找设备
        const devices = await svc.listDevices();
        const device = devices.find((d: any) => 
            d.ieee_address === deviceId || 
            d.friendly_name === deviceId ||
            String(d.ieee_address).toLowerCase() === String(deviceId).toLowerCase()
        );
        
        if (!device) {
            throw new Error(`设备未找到: ${deviceId}`);
        }
        
        deviceInfo = device;
        
        // 尝试读取设备的当前状态（genOnOff cluster 的 onOff 属性）
        try {
            const herdsman = (svc as any).herdsman;
            if (herdsman) {
                const allDevices = herdsman.getDevices?.() || [];
                const rawDevice = allDevices.find((d: any) => 
                    d.ieeeAddr === device.ieee_address ||
                    String(d.ieeeAddr).toLowerCase() === String(device.ieee_address).toLowerCase()
                );
                
                if (rawDevice) {
                    const endpoints = rawDevice.endpoints || [];
                    const GEN_ONOFF_ID = 6;
                    const hasOnOff = (ep: any): boolean => {
                        try {
                            if (ep?.supportsInputCluster && ep.supportsInputCluster('genOnOff')) return true;
                            if (Array.isArray(ep?.inputClusters) && ep.inputClusters.includes(GEN_ONOFF_ID)) return true;
                            return false;
                        } catch {}
                        return false;
                    };
                    
                    for (const ep of endpoints) {
                        if (hasOnOff(ep)) {
                            try {
                                // 读取 onOff 属性（0 = OFF, 1 = ON）
                                const attrs = await ep.read('genOnOff', ['onOff']);
                                if (attrs && typeof attrs.onOff === 'number') {
                                    currentState = attrs.onOff === 1 ? 'ON' : 'OFF';
                                    break;
                                }
                            } catch (e) {
                                // 读取失败，可能设备离线或未响应
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // 读取状态失败，但不影响返回基本信息
        }
    });
    
    // 判断设备是否在线：
    // 1. 如果能成功读取到状态（currentState 不为"未知"），说明设备在线
    // 2. 否则，基于 lastSeen 时间戳判断（10分钟内见过视为在线）
    const isOnline = currentState !== null && currentState !== '未知' 
        ? true 
        : (deviceInfo.lastSeen ? (Date.now() - deviceInfo.lastSeen) < 600000 : false);
    
    return {
        deviceId: deviceInfo.ieee_address,
        friendlyName: deviceInfo.friendly_name || deviceInfo.ieee_address,
        model: deviceInfo.definition?.model || '未知型号',
        vendor: deviceInfo.definition?.vendor || '未知厂商',
        type: deviceInfo.type === 'Router' ? '路由器' : (deviceInfo.type === 'EndDevice' ? '终端设备' : deviceInfo.type || '未知'),
        powerSource: deviceInfo.powerSource,
        lastSeen: deviceInfo.lastSeen ? new Date(deviceInfo.lastSeen).toISOString() : null,
        currentState: currentState || '未知', // ON, OFF, 或 未知（如果无法读取）
        supportsOnOff: deviceInfo.supportsOnOff,
        online: isOnline,
    };
    
    logger.info('[zigbee_get_device_status] 设备 %s 状态: %s (在线: %s)', deviceId, result.currentState, result.online);
    return result;
}

// 控制设备开关
export const zigbeeControlTool = {
    name: 'zigbee_control_device',
    description: '控制 Zigbee 设备的开关状态。支持开（ON）、关（OFF）、切换（TOGGLE）。如果用户说"开启他/它"或"关闭它"等，且上下文中有最近查询过的设备，应该使用该设备的 deviceId。如果只有一个设备，也可以直接使用该设备ID。',
    parameters: {
        type: 'object',
        properties: {
            deviceId: {
                type: 'string',
                description: '设备 IEEE 地址或友好名称。如果用户没有明确指定设备，应该从上下文或最近查询的设备列表中获取。如果只有一个设备，使用该设备的 deviceId。可通过 zigbee_list_devices 获取设备列表。',
            },
            state: {
                type: 'string',
                enum: ['ON', 'OFF', 'TOGGLE'],
                description: '设备状态：ON 表示开启（开、打开、开启等），OFF 表示关闭（关、关闭等），TOGGLE 表示切换当前状态（切换、反转等）',
            },
        },
        required: ['deviceId', 'state'],
    },
};

export async function callZigbeeControlTool(ctx: Context, args: any): Promise<any> {
    const { deviceId, state } = args;
    
    logger.info('[zigbee_control_device] 控制设备: %s -> %s', deviceId, state);
    
    if (!deviceId || !state) {
        throw new Error('缺少必要参数：deviceId 和 state');
    }
    
    if (!['ON', 'OFF', 'TOGGLE'].includes(state)) {
        throw new Error('state 必须是 "ON"、"OFF" 或 "TOGGLE"');
    }
    
    await ctx.inject(['zigbee'], async (c) => {
        const svc = c.zigbee;
        if (!svc) {
            throw new Error('Zigbee 服务未初始化');
        }
        await svc.setDeviceState(deviceId, { state });
    });
    
    const result = {
        success: true,
        deviceId,
        state,
        message: `设备 ${deviceId} 已${state === 'ON' ? '开启' : state === 'OFF' ? '关闭' : '切换状态'}`,
    };
    
    logger.success('[zigbee_control_device] 控制成功: %s -> %s', deviceId, state);
    return result;
}

