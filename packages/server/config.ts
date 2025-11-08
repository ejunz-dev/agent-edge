import path from 'node:path';
import Schema from 'schemastery';
import { version as packageVersion } from './package.json';
import {
    fs, Logger, randomstring, yaml,
} from './utils';

const logger = new Logger('init');

logger.info('Loading config');
const isClient = process.argv.includes('--client');
const isNode = process.argv.includes('--node');
const configPath = path.resolve(process.cwd(), `config.${isClient ? 'client' : isNode ? 'node' : 'server'}.yaml`);
fs.ensureDirSync(path.resolve(process.cwd(), 'data'));

// eslint-disable-next-line import/no-mutable-exports
export let exit: Promise<void> | null = null;

if (!fs.existsSync(configPath)) {
    // eslint-disable-next-line no-promise-executor-return
    exit = new Promise((resolve) => (async () => {
        const serverConfigDefault = `\
# 仅需填写 host，其它保持注释既可
host: '' # 例如 edge.example.com:5283 或 10.0.0.5:5283

# 下面是可选项，暂不需要使用，保留注释
# type: server # server | domjudge | ejunz
# port: 5283
# xhost: x-forwarded-host
# viewPass: ${randomstring(8)} # use admin / viewPass to login
# secretRoute: ${randomstring(12)}
# seatFile: /home/icpc/Desktop/seats.txt
# customKeyfile: 
# edgeUpstream: '' # e.g. ws://host:port/edge/conn
# server: 
# token: 
# username: 
# password: 
# monitor:
#   timeSync: false
# 语音服务配置（可选）
# voice:
#   asr:
#     provider: 'openai' # 'openai', 'azure', 'baidu', 'custom'
#     apiKey: ''
#     endpoint: 'https://api.openai.com/v1/audio/transcriptions'
#     model: 'whisper-1'
#   tts:
#     provider: 'openai' # 'openai', 'azure', 'baidu', 'custom'
#     apiKey: ''
#     endpoint: 'https://api.openai.com/v1/audio/speech'
#     voice: 'alloy' # 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'
#   ai:
#     provider: 'openai' # 'openai', 'azure', 'custom'
#     apiKey: ''
#     endpoint: 'https://api.openai.com/v1/chat/completions'
#     model: 'gpt-3.5-turbo'
# Zigbee2MQTT（可选）
# zigbee2mqtt:
#   enabled: false
#   mqttUrl: 'mqtt://localhost:1883'
#   baseTopic: 'zigbee2mqtt'
#   username: ''
#   password: ''
#   autoStart: false
#   adapter: '/dev/ttyUSB0'
`;
        const nodeConfigDefault = `\
# 控制节点（Node）配置，仅负责 Zigbee2MQTT 管理与设备控制桥接
port: 5284
# 上游服务器WebSocket连接地址（用于主动连接上游服务器）
upstream: 'ws://localhost:5283' # 例如 'ws://192.168.1.10:5283' 或 'wss://example.com'
# 上游MQTT Broker配置（不是本项目的server）
mqtt:
  mqttUrl: 'mqtt://localhost:1883' # 上游MQTT Broker地址
  baseTopic: 'zigbee2mqtt'
  username: ''
  password: ''
zigbee2mqtt:
  enabled: true
  mqttUrl: 'mqtt://localhost:1883' # 连接到上游MQTT Broker（优先使用mqtt配置）
  baseTopic: 'zigbee2mqtt'
  username: ''
  password: ''
  autoStart: true # node 启动时自动拉起 zigbee2mqtt 进程
  adapter: '/dev/ttyUSB0'
`;
        const clientConfigDefault = yaml.dump({
            server: '',
        });
        fs.writeFileSync(configPath, isClient ? clientConfigDefault : isNode ? nodeConfigDefault : serverConfigDefault);
        logger.error('Config file generated, please fill in the config.yaml');
        resolve();
    })());
    throw new Error('no-config');
}

const serverSchema = Schema.object({
    // 为最简配置而精简，仅保留 host 与必要默认项
    host: Schema.string().default(''),
    edgeUpstream: Schema.string().default(''),
    // 保留以下默认项以兼容日志与现有代码（无需在配置中填写）
    port: Schema.number().default(5283),
    xhost: Schema.string().default('x-forwarded-host'),
    viewPass: Schema.string().default(randomstring(8)),
    secretRoute: Schema.string().default(randomstring(12)),
    seatFile: Schema.string().default('/home/icpc/Desktop/seat.txt'),
    customKeyfile: Schema.string().default(''),
    monitor: Schema.object({
        timeSync: Schema.boolean().default(false),
    }).default({ timeSync: false }),
    // 语音服务配置
    voice: Schema.object({
        // ASR (语音转文字) 配置
        asr: Schema.object({
            provider: Schema.string().default(''), // 'openai', 'qwen-realtime', 'azure', 'baidu', 'custom'
            apiKey: Schema.string().default(''),
            endpoint: Schema.string().default(''),
            model: Schema.string().default('whisper-1'), // OpenAI默认模型，qwen使用 qwen3-asr-flash-realtime
            // Qwen实时ASR专用配置
            enableServerVad: Schema.boolean().default(true), // true为VAD模式，false为Manual模式
            baseUrl: Schema.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'), // Qwen WebSocket地址（官方格式）
            language: Schema.string().default('zh'), // 识别语言
        }).default({
            provider: '',
            apiKey: '',
            endpoint: '',
            model: 'whisper-1',
            enableServerVad: true,
            baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
            language: 'zh',
        }),
        // TTS (文字转语音) 配置
        tts: Schema.object({
            provider: Schema.string().default(''), // 'openai', 'qwen', 'azure', 'baidu', 'custom'
            apiKey: Schema.string().default(''),
            endpoint: Schema.string().default(''),
            voice: Schema.string().default('alloy'), // OpenAI默认声音，Qwen可用: Cherry等
            // Qwen TTS专用配置
            model: Schema.string().default('qwen3-tts-flash'), // Qwen模型
            languageType: Schema.string().default('Chinese'), // 语言类型
        }).default({
            provider: '',
            apiKey: '',
            endpoint: '',
            voice: 'alloy',
            model: 'qwen3-tts-flash',
            languageType: 'Chinese',
        }),
        // AI对话API配置
        ai: Schema.object({
            provider: Schema.string().default(''), // 'openai', 'ejunz', 'azure', 'custom'
            apiKey: Schema.string().default(''),
            endpoint: Schema.string().default(''),
            model: Schema.string().default('gpt-3.5-turbo'),
            // 自定义API配置
            authHeader: Schema.string().default('Authorization'), // API Key的Header名称，如 'X-API-Key', 'Authorization'
            authPrefix: Schema.string().default('Bearer'), // API Key前缀，如 'Bearer', '' (空字符串表示不加前缀)
            requestFormat: Schema.string().default('openai'), // 'openai' (标准OpenAI格式) 或 'simple' (简单message格式)
        }).default({
            provider: '',
            apiKey: '',
            endpoint: '',
            model: 'gpt-3.5-turbo',
            authHeader: 'Authorization',
            authPrefix: 'Bearer',
            requestFormat: 'openai',
        }),
        // 键盘控制配置
        keyboard: Schema.object({
            listenKey: Schema.string().default('Backquote'), // 监听按键，默认为反引号键 `（支持：Space, Control, Alt, Shift, Enter, Backspace, Delete, Tab, Escape, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F12, A-Z, 0-9, Backquote 等）
            modifiers: Schema.array(Schema.string()).default([]), // 修饰键数组，例如：['Control', 'Shift'] 表示 Ctrl+Shift+主键
        }).default({
            listenKey: 'Backquote',
            modifiers: [],
        }),
        // VTuber 配置
        vtuber: Schema.object({
            enabled: Schema.boolean().default(true), // 是否启用 VTuber 控制
            engine: Schema.string().default('vtubestudio').role('radio', ['vtubestudio', 'osc']), // VTuber 引擎类型：vtubestudio（VTube Studio）、osc（OSC协议如VSeeFace）
            vtubestudio: Schema.object({
                host: Schema.string().default('127.0.0.1'), // VTube Studio WebSocket 主机
                port: Schema.number().default(8001), // VTube Studio WebSocket 端口（默认 8001）
                apiName: Schema.string().default('Agent Edge VTuber Control'), // API 名称
                apiVersion: Schema.string().default('1.0'), // API 版本
                authToken: Schema.string().default(''), // 认证令牌（首次连接后自动保存）
                audioSync: Schema.object({
                    enabled: Schema.boolean().default(false), // 是否启用音频同步（嘴型同步）
                    // 注意：VTube Studio 不播放音频，只用于嘴型同步
                    // 音频仍需要通过系统播放，以便直播软件（如 OBS）捕获
                    parameterName: Schema.string().default('VoiceVolume'), // 用于嘴型同步的参数名称
                    updateInterval: Schema.number().default(100), // 参数更新间隔（毫秒）
                }).default({
                    enabled: false,
                    parameterName: 'VoiceVolume',
                    updateInterval: 100,
                }),
            }).default({
                host: '127.0.0.1',
                port: 8001,
                apiName: 'Agent Edge VTuber Control',
                apiVersion: '1.0',
                authToken: '',
                audioSync: { enabled: false, useForPlayback: false, parameterName: 'VoiceVolume', updateInterval: 100 },
            }),
            osc: Schema.object({
                enabled: Schema.boolean().default(false), // 是否启用 OSC 桥接（用于桌面应用）
                host: Schema.string().default('127.0.0.1'), // OSC 目标主机
                port: Schema.number().default(9000), // OSC 目标端口（VSeeFace 默认 9000）
            }).default({
                enabled: false,
                host: '127.0.0.1',
                port: 9000,
            }),
        }).default({
            enabled: true,
            engine: 'vtubestudio',
            vtubestudio: { host: '127.0.0.1', port: 8001, apiName: 'Agent Edge VTuber Control', apiVersion: '1.0', authToken: '', audioSync: { enabled: false, parameterName: 'VoiceVolume', updateInterval: 100 } },
            osc: { enabled: false, host: '127.0.0.1', port: 9000 },
        }),
    }).default({
        asr: { provider: '', apiKey: '', endpoint: '', model: 'whisper-1', enableServerVad: true, baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', language: 'zh' },
        tts: { provider: '', apiKey: '', endpoint: '', voice: 'alloy', model: 'qwen3-tts-flash', languageType: 'Chinese' },
        ai: { provider: '', apiKey: '', endpoint: '', model: 'gpt-3.5-turbo', authHeader: 'Authorization', authPrefix: 'Bearer', requestFormat: 'openai' },
        keyboard: { listenKey: 'Backquote', modifiers: [] },
        vtuber: { enabled: true, engine: 'vtubestudio', vtubestudio: { host: '127.0.0.1', port: 8001, apiName: 'Agent Edge VTuber Control', apiVersion: '1.0', authToken: '', audioSync: { enabled: false, useForPlayback: false, parameterName: 'VoiceVolume', updateInterval: 100 } }, osc: { enabled: false, host: '127.0.0.1', port: 9000 } },
    }),
    // Zigbee2MQTT 配置
    zigbee2mqtt: Schema.object({
        enabled: Schema.boolean().default(false),
        mqttUrl: Schema.string().default('mqtt://localhost:1883'),
        baseTopic: Schema.string().default('zigbee2mqtt'),
        username: Schema.string().default(''),
        password: Schema.string().default(''),
        autoStart: Schema.boolean().default(false),
        adapter: Schema.string().default('/dev/ttyUSB0'),
    }).default({
        enabled: false,
        mqttUrl: 'mqtt://localhost:1883',
        baseTopic: 'zigbee2mqtt',
        username: '',
        password: '',
        autoStart: false,
        adapter: '/dev/ttyUSB0',
    }),
}).description('Basic Config');
const clientSchema = Schema.object({
    server: Schema.transform(String, (i) => (i.endsWith('/') ? i : `${i}/`)).role('url').required(),
});

const nodeSchema = Schema.object({
    port: Schema.number().default(5283),
    upstream: Schema.string().default('ws://localhost:5283'), // 上游服务器WebSocket连接地址
    mqtt: Schema.object({
        mqttUrl: Schema.string().default('mqtt://localhost:1883'),
        baseTopic: Schema.string().default('zigbee2mqtt'),
        username: Schema.string().default(''),
        password: Schema.string().default(''),
    }).default({
        mqttUrl: 'mqtt://localhost:1883',
        baseTopic: 'zigbee2mqtt',
        username: '',
        password: '',
    }),
    broker: Schema.object({
        enabled: Schema.boolean().default(true),
        port: Schema.number().default(1883),
        wsPort: Schema.number().default(8083),
    }).default({ enabled: true, port: 1883, wsPort: 8083 }),
    // MQTT 桥接配置（支持连接多个 broker）
    mqttBridge: Schema.object({
        enabled: Schema.boolean().default(true),
        reconnect: Schema.object({
            enabled: Schema.boolean().default(true), // 是否启用自动重连
            period: Schema.number().default(5000), // 重连间隔（毫秒）
        }).default({
            enabled: true,
            period: 5000,
        }),
        brokers: Schema.array(Schema.object({
            name: Schema.string().required(),
            mqttUrl: Schema.string().required(),
            baseTopic: Schema.string().default('zigbee2mqtt'),
            username: Schema.string().default(''),
            password: Schema.string().default(''),
            enabled: Schema.boolean().default(true),
            reconnect: Schema.object({
                enabled: Schema.boolean().default(true), // 单个broker是否启用自动重连（继承全局配置）
                period: Schema.number().default(5000), // 单个broker重连间隔（继承全局配置）
            }).default({
                enabled: true,
                period: 5000,
            }),
        })).default([]),
    }).default({
        enabled: true,
        reconnect: {
            enabled: true,
            period: 5000,
        },
        brokers: [],
    }),
    zigbee2mqtt: Schema.object({
        enabled: Schema.boolean().default(true),
        mqttUrl: Schema.string().default('mqtt://localhost:1883'),
        baseTopic: Schema.string().default('zigbee2mqtt'),
        username: Schema.string().default(''),
        password: Schema.string().default(''),
        autoStart: Schema.boolean().default(true), // node 模式下默认自动启动
        adapter: Schema.string().default('/dev/ttyUSB0'),
    }).default({
        enabled: true,
        mqttUrl: 'mqtt://localhost:1883',
        baseTopic: 'zigbee2mqtt',
        username: '',
        password: '',
        autoStart: true,
        adapter: '/dev/ttyUSB0',
    }),
}).description('Node Config');

export const config = (isClient ? clientSchema : isNode ? nodeSchema : serverSchema)(yaml.load(fs.readFileSync(configPath, 'utf8')) as any);
export const saveConfig = () => {
    fs.writeFileSync(configPath, yaml.dump(config));
};
export const version = packageVersion;

logger.info(`Config loaded from ${configPath}`);
logger.info(`agent-edge version: ${packageVersion}`);
if (!isClient && !exit) logger.info(`Server View User Info: admin / ${config.viewPass}`);
