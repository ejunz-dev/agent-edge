// @ts-nocheck
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';

const logger = new Logger('node-mcp-zigbee');

// 列出所有 Zigbee 设备
export const zigbeeListDevicesTool = {
    name: 'zigbee_list_devices',
    description: '列出所有可用的 Zigbee 设备（开关、插座等），返回设备的基本信息和标识符。当用户询问"有哪些设备"、"设备列表"、"查看设备"等问题时，应该主动调用此工具。当需要查询或控制设备但用户没有指定设备ID时，也应该先调用此工具获取设备列表。',
    inputSchema: {
        type: 'object',
        properties: {},
        required: [],
    },
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
};

export async function callZigbeeListDevicesTool(ctx: Context, args: any): Promise<any> {
    logger.info('[zigbee_list_devices] 开始列出设备');
    let devices: any[] = [];
    
    await ctx.inject(['zigbee2mqtt'], async (c) => {
        const svc = c.zigbee2mqtt;
        if (!svc) {
            throw new Error('Zigbee2MQTT 服务未初始化');
        }
        devices = await svc.listDevices();
    });
    
    const result = {
        count: devices.length,
        devices: devices.map((d: any) => ({
            deviceId: d.friendly_name || d.ieee_address,
            friendlyName: d.friendly_name || d.ieee_address,
            model: d.definition?.model || d.model || '未知型号',
            vendor: d.definition?.vendor || d.vendor || '未知厂商',
            type: d.type === 'Router' ? '路由器' : (d.type === 'EndDevice' ? '终端设备' : d.type || '未知'),
            powerSource: d.powerSource,
            lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
            supportsOnOff: d.supportsOnOff !== false, // zigbee2mqtt 设备默认支持开关
        })),
    };
    
    logger.info('[zigbee_list_devices] 找到 %d 个设备', result.count);
    return result;
}

// 获取设备状态
export const zigbeeGetDeviceStatusTool = {
    name: 'zigbee_get_device_status',
    description: '获取指定 Zigbee 设备的当前状态（开关状态、在线状态等）。当用户询问"开关状态"、"设备状态"、"什么情况"、"开还是关"、"是否开启"等问题时，应该主动调用此工具查询设备状态。**重要：调用此工具时必须提供 deviceId 参数。**如果用户没有明确指定设备ID，应该先调用 zigbee_list_devices 获取设备列表，然后从返回的设备列表中选择一个设备的 deviceId 作为参数。如果只有一个设备，使用该设备的 deviceId；如果有多个设备，使用用户提到的设备名称或从上下文推断的设备ID。',
    inputSchema: {
        type: 'object',
        properties: {
            deviceId: {
                type: 'string',
                description: '**必需参数**：设备 IEEE 地址或友好名称（例如 "0xa4c1388b3518f6ce"）。如果用户没有明确指定，必须先从 zigbee_list_devices 获取设备列表，然后从返回的设备中选择一个设备的 deviceId 字段值。如果只有一个设备，使用该设备的 deviceId；如果有多个设备，使用用户提到的设备名称或从上下文推断的设备ID。不能为空。',
            },
        },
        required: ['deviceId'],
    },
    parameters: {
        type: 'object',
        properties: {
            deviceId: {
                type: 'string',
                description: '**必需参数**：设备 IEEE 地址或友好名称（例如 "0xa4c1388b3518f6ce"）。如果用户没有明确指定，必须先从 zigbee_list_devices 获取设备列表，然后从返回的设备中选择一个设备的 deviceId 字段值。如果只有一个设备，使用该设备的 deviceId；如果有多个设备，使用用户提到的设备名称或从上下文推断的设备ID。不能为空。',
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
    
    await ctx.inject(['zigbee2mqtt'], async (c) => {
        const svc = c.zigbee2mqtt;
        if (!svc) {
            throw new Error('Zigbee2MQTT 服务未初始化');
        }
        
        // 获取设备列表以查找设备
        const devices = await svc.listDevices();
        const device = devices.find((d: any) => 
            d.friendly_name === deviceId || 
            d.ieee_address === deviceId ||
            String(d.friendly_name).toLowerCase() === String(deviceId).toLowerCase() ||
            String(d.ieee_address).toLowerCase() === String(deviceId).toLowerCase()
        );
        
        if (!device) {
            throw new Error(`设备未找到: ${deviceId}`);
        }
        
        deviceInfo = device;
        
        // zigbee2mqtt 通过 MQTT 获取设备状态
        // 设备状态通常从 MQTT topic 中获取，这里我们尝试从设备信息中获取
        // 如果设备有 state 字段，使用它；否则尝试从 last_seen 判断在线状态
        if (device.state) {
            currentState = device.state.state === 'ON' ? 'ON' : (device.state.state === 'OFF' ? 'OFF' : null);
        }
    });
    
    // 判断设备是否在线：基于 lastSeen 时间戳判断（10分钟内见过视为在线）
    const isOnline = deviceInfo.lastSeen ? (Date.now() - new Date(deviceInfo.lastSeen).getTime()) < 600000 : false;
    
    const result = {
        deviceId: deviceInfo.friendly_name || deviceInfo.ieee_address,
        friendlyName: deviceInfo.friendly_name || deviceInfo.ieee_address,
        model: deviceInfo.definition?.model || deviceInfo.model || '未知型号',
        vendor: deviceInfo.definition?.vendor || deviceInfo.vendor || '未知厂商',
        type: deviceInfo.type === 'Router' ? '路由器' : (deviceInfo.type === 'EndDevice' ? '终端设备' : deviceInfo.type || '未知'),
        powerSource: deviceInfo.powerSource,
        lastSeen: deviceInfo.lastSeen ? new Date(deviceInfo.lastSeen).toISOString() : null,
        currentState: currentState || '未知', // ON, OFF, 或 未知（如果无法读取）
        supportsOnOff: deviceInfo.supportsOnOff !== false,
        online: isOnline,
    };
    
    logger.info('[zigbee_get_device_status] 设备 %s 状态: %s (在线: %s)', deviceId, result.currentState, result.online);
    return result;
}

// 控制设备开关
export const zigbeeControlTool = {
    name: 'zigbee_control_device',
    description: '控制 Zigbee 设备的开关状态。支持开（ON）、关（OFF）、切换（TOGGLE）。**重要：调用此工具时必须提供 deviceId 和 state 两个参数。**如果用户说"开启他/它"或"关闭它"等，且上下文中有最近查询过的设备，应该使用该设备的 deviceId。如果用户没有明确指定设备，必须先调用 zigbee_list_devices 获取设备列表，然后从返回的设备中选择一个设备的 deviceId。state 参数根据用户的意图设置：用户说"开"、"打开"、"开启"等时使用 "ON"；用户说"关"、"关闭"等时使用 "OFF"；用户说"切换"、"反转"等时使用 "TOGGLE"。',
    inputSchema: {
        type: 'object',
        properties: {
            deviceId: {
                type: 'string',
                description: '**必需参数**：设备 IEEE 地址或友好名称（例如 "0xa4c1388b3518f6ce"）。如果用户没有明确指定设备，必须先从 zigbee_list_devices 获取设备列表，然后从返回的设备中选择一个设备的 deviceId 字段值。如果只有一个设备，使用该设备的 deviceId；如果有多个设备，使用用户提到的设备名称或从上下文推断的设备ID。不能为空。',
            },
            state: {
                type: 'string',
                enum: ['ON', 'OFF', 'TOGGLE'],
                description: '**必需参数**：设备状态。ON 表示开启（当用户说"开"、"打开"、"开启"等时使用）；OFF 表示关闭（当用户说"关"、"关闭"等时使用）；TOGGLE 表示切换当前状态（当用户说"切换"、"反转"等时使用）。不能为空。',
            },
        },
        required: ['deviceId', 'state'],
    },
    parameters: {
        type: 'object',
        properties: {
            deviceId: {
                type: 'string',
                description: '**必需参数**：设备 IEEE 地址或友好名称（例如 "0xa4c1388b3518f6ce"）。如果用户没有明确指定设备，必须先从 zigbee_list_devices 获取设备列表，然后从返回的设备中选择一个设备的 deviceId 字段值。如果只有一个设备，使用该设备的 deviceId；如果有多个设备，使用用户提到的设备名称或从上下文推断的设备ID。不能为空。',
            },
            state: {
                type: 'string',
                enum: ['ON', 'OFF', 'TOGGLE'],
                description: '**必需参数**：设备状态。ON 表示开启（当用户说"开"、"打开"、"开启"等时使用）；OFF 表示关闭（当用户说"关"、"关闭"等时使用）；TOGGLE 表示切换当前状态（当用户说"切换"、"反转"等时使用）。不能为空。',
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
    
    await ctx.inject(['zigbee2mqtt'], async (c) => {
        const svc = c.zigbee2mqtt;
        if (!svc) {
            throw new Error('Zigbee2MQTT 服务未初始化');
        }
        
        // 检查 deviceId 是否包含端点信息（格式：deviceName_l1）
        let targetDeviceId = deviceId;
        let endpoint: string | undefined;
        
        const endpointMatch = deviceId.match(/^(.+)_(l\d+)$/);
        if (endpointMatch) {
            // 提取原始设备ID和端点
            const baseDeviceId = endpointMatch[1];
            endpoint = endpointMatch[2];
            logger.info('[zigbee_control_device] 检测到端点控制: 设备=%s, 端点=%s', baseDeviceId, endpoint);
            
            // 查找原始设备
            const devices = await svc.listDevices();
            const device = devices.find((d: any) => 
                d.friendly_name === baseDeviceId || 
                d.ieee_address === baseDeviceId ||
                String(d.friendly_name).toLowerCase() === String(baseDeviceId).toLowerCase()
            );
            targetDeviceId = device ? (device.friendly_name || device.ieee_address) : baseDeviceId;
        } else {
            // 单端点设备：正常查找
            const devices = await svc.listDevices();
            const device = devices.find((d: any) => 
                d.friendly_name === deviceId || 
                d.ieee_address === deviceId ||
                String(d.friendly_name).toLowerCase() === String(deviceId).toLowerCase()
            );
            targetDeviceId = device ? (device.friendly_name || device.ieee_address) : deviceId;
        }
        
        // 构建控制命令
        let controlCommand: any = { state };
        if (endpoint) {
            // 对于多端点设备，使用特定的状态键
            controlCommand = { [`state_${endpoint}`]: state };
        }
        
        logger.info('[zigbee_control_device] 发送控制命令: %s -> %o', targetDeviceId, controlCommand);
        await svc.setDeviceState(targetDeviceId, controlCommand);
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

