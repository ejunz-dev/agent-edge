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
const isProxy = process.argv.includes('--proxy');
const isProvider = process.argv.includes('--provider');
const configPath = path.resolve(process.cwd(), `config.${isClient ? 'client' : isNode ? 'node' : isProvider ? 'provider' : 'server'}.yaml`);
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
# 对外暴露的地址和端口（可选，如果服务器需要回连本节点）
publicHost: '' # 例如 '192.168.1.20'，留空则自动使用主机名
publicPort: 0 # 0 表示使用 port 配置
# 自定义节点 ID（可选，留空则使用主机名）
nodeId: ''
# Edge WebSocket 连接配置（必需）
ws:
  endpoint: 'wss://example.com/mcp/ws?token=xxx' # 上游 Edge WebSocket endpoint (完整 URL)
  localEndpoint: '/mcp/ws' # 本地 WebSocket 服务器路径（可选）
  enabled: true
# Zigbee2MQTT 配置（连接到本地 MQTT Broker，默认 localhost:1883）
zigbee2mqtt:
  enabled: true
  baseTopic: 'zigbee2mqtt' # MQTT 主题前缀
  autoStart: true # node 启动时自动拉起 zigbee2mqtt 进程
  adapter: '/dev/ttyUSB0' # Zigbee 适配器设备路径
`;
        const clientConfigDefault = yaml.dump({
            server: '',
        });
        const providerConfigDefault = `\
# MCP Provider 配置
port: 5285
# WebSocket 接入点配置
ws:
  endpoint: '/mcp/ws' # 本地 WebSocket 服务器路径
  upstream: '' # 上游 MCP WebSocket endpoint (完整 URL，如 wss://example.com/mcp/ws?token=xxx)
  enabled: true
# MCP 工具配置
tools:
  get_current_time:
    enabled: true
    description: '获取当前时间和日期信息'
  get_server_status:
    enabled: true
    description: '获取服务器状态信息，包括 CPU、内存、系统信息等'
`;
        fs.writeFileSync(configPath, isClient ? clientConfigDefault : isNode ? nodeConfigDefault : isProvider ? providerConfigDefault : serverConfigDefault);
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
    // 插件配置
    plugins: Schema.object({
        voice: Schema.object({
            enabled: Schema.boolean().default(true),
            settings: Schema.object({
                enabled: Schema.boolean().default(true),
                host: Schema.string().default(''),
                asr: Schema.object({
                    provider: Schema.string().default(''), // 'openai', 'qwen-realtime', 'azure', 'baidu', 'custom'
                    apiKey: Schema.string().default(''),
                    model: Schema.string().default(''), // OpenAI默认模型，qwen使用 qwen3-asr-flash-realtime
                    enableServerVad: Schema.boolean().default(true), // true为VAD模式，false为Manual模式
                    baseUrl: Schema.string().default('wss://dashscope.aliyuncs.com/api-ws/v1/realtime'), // Qwen WebSocket地址（官方格式）
                    language: Schema.string().default('zh'), // 识别语言
                }),
                // TTS (文字转语音) 配置
                tts: Schema.object({
                    provider: Schema.string().default(''), // 'openai', 'qwen', 'azure', 'baidu', 'custom'
                    apiKey: Schema.string().default(''),
                    endpoint: Schema.string().default(''),
                    voice: Schema.string().default(''), // OpenAI默认声音，Qwen可用: Cherry等
                    model: Schema.string().default(''), // Qwen模型
                    languageType: Schema.string().default(''), // 语言类型
                }),
                // AI对话API配置
                ai: Schema.object({
                    provider: Schema.string().default('ejunz'), // 'openai', 'ejunz', 'azure', 'custom'
                    endpoint: Schema.string().default(''),
                    requestFormat: Schema.string().default('simple'), // 'openai' (标准OpenAI格式) 或 'simple' (简单message格式)
                }),
            }),
        }),
    }),
}).description('Basic Config');
const clientSchema = Schema.object({
    server: Schema.transform(String, (i) => (i.endsWith('/') ? i : `${i}/`)).role('url').required(),
});

const nodeSchema = Schema.object({
    nodeId: Schema.string().default(''),
    port: Schema.number().default(5284),
    publicHost: Schema.string().default(''),
    publicPort: Schema.number().default(0),
    // 本地 MQTT Broker（默认启用，端口1883，无需配置）
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
        baseTopic: Schema.string().default('zigbee2mqtt'),
        autoStart: Schema.boolean().default(true), // node 模式下默认自动启动
        adapter: Schema.string().default('/dev/ttyUSB0'),
    }).default({
        enabled: true,
        baseTopic: 'zigbee2mqtt',
        autoStart: true,
        adapter: '/dev/ttyUSB0',
    }),
    // Edge WebSocket 连接配置（必需）
    ws: Schema.object({
        endpoint: Schema.string().default(''), // 上游 Edge WebSocket endpoint (完整 URL，如 wss://example.com/mcp/ws?token=xxx)
        localEndpoint: Schema.string().default('/mcp/ws'), // 本地 WebSocket 服务器路径（可选）
        enabled: Schema.boolean().default(true),
    }).default({
        endpoint: '',
        localEndpoint: '/mcp/ws',
        enabled: true,
    }),
}).description('Node Config');

const providerSchema = Schema.object({
    port: Schema.number().default(5285),
    ws: Schema.object({
        endpoint: Schema.string().default('/mcp/ws'), // 本地 WebSocket 服务器路径
        upstream: Schema.string().default(''), // 上游 MCP WebSocket endpoint (完整 URL，如 wss://example.com/mcp/ws?token=xxx)
        enabled: Schema.boolean().default(true),
    }).default({
        endpoint: '/mcp/ws',
        upstream: '',
        enabled: true,
    }),
    tools: Schema.object({
        get_current_time: Schema.object({
            enabled: Schema.boolean().default(true),
            description: Schema.string().default('获取当前时间和日期信息'),
        }).default({
            enabled: true,
            description: '获取当前时间和日期信息',
        }),
        get_server_status: Schema.object({
            enabled: Schema.boolean().default(true),
            description: Schema.string().default('获取服务器状态信息，包括 CPU、内存、系统信息等'),
        }).default({
            enabled: true,
            description: '获取服务器状态信息，包括 CPU、内存、系统信息等',
        }),
    }).default({
        get_current_time: { enabled: true, description: '获取当前时间和日期信息' },
        get_server_status: { enabled: true, description: '获取服务器状态信息，包括 CPU、内存、系统信息等' },
    }),
    viewPass: Schema.string().default(randomstring(8)),
}).description('Provider Config');

export const config = (isClient ? clientSchema : isNode ? nodeSchema : isProvider ? providerSchema : serverSchema)(yaml.load(fs.readFileSync(configPath, 'utf8')) as any);
export const saveConfig = () => {
    fs.writeFileSync(configPath, yaml.dump(config));
};
export const version = packageVersion;

logger.info(`Config loaded from ${configPath}`);
logger.info(`agent-edge version: ${packageVersion}`);
if (!isClient && !exit) logger.info(`Server View User Info: admin / ${config.viewPass}`);
