import path from 'node:path';
import Schema from 'schemastery';
import { version as packageVersion } from './package.json';
import {
    fs, Logger, randomstring, yaml,
} from './utils';

const logger = new Logger('init');

logger.info('Loading config');
const isClient = process.argv.includes('--client');
const configPath = path.resolve(process.cwd(), `config.${isClient ? 'client' : 'server'}.yaml`);
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
`;
        const clientConfigDefault = yaml.dump({
            server: '',
        });
        fs.writeFileSync(configPath, isClient ? clientConfigDefault : serverConfigDefault);
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
    }).default({
        asr: { provider: '', apiKey: '', endpoint: '', model: 'whisper-1', enableServerVad: true, baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', language: 'zh' },
        tts: { provider: '', apiKey: '', endpoint: '', voice: 'alloy', model: 'qwen3-tts-flash', languageType: 'Chinese' },
        ai: { provider: '', apiKey: '', endpoint: '', model: 'gpt-3.5-turbo', authHeader: 'Authorization', authPrefix: 'Bearer', requestFormat: 'openai' },
    }),
}).description('Basic Config');
const clientSchema = Schema.object({
    server: Schema.transform(String, (i) => (i.endsWith('/') ? i : `${i}/`)).role('url').required(),
});

export const config = (isClient ? clientSchema : serverSchema)(yaml.load(fs.readFileSync(configPath, 'utf8')) as any);
export const saveConfig = () => {
    fs.writeFileSync(configPath, yaml.dump(config));
};
export const version = packageVersion;

logger.info(`Config loaded from ${configPath}`);
logger.info(`agent-edge version: ${packageVersion}`);
if (!isClient && !exit) logger.info(`Server View User Info: admin / ${config.viewPass}`);
