import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { getVoiceClient } from './client';

const logger = new Logger('voice-auto');

// 动态引入ws模块
let WS: any;
try {
    WS = require('ws');
} catch {
    logger.warn('未找到 ws 模块，实时 ASR 功能将不可用');
}

// 动态引入ffmpeg安装器，获取ffmpeg可执行文件路径
let ffmpegPath: string | null = null;
try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpegPath = ffmpegInstaller.path;
    logger.info('已加载通过 npm 安装的 ffmpeg: %s', ffmpegPath);
} catch {
    ffmpegPath = 'ffmpeg';
    logger.debug('未找到 @ffmpeg-installer/ffmpeg，将使用系统 PATH 中的 ffmpeg');
}

function getFfmpegPath(): string {
    return ffmpegPath || 'ffmpeg';
}

/**
 * 计算音频数据的音量（RMS，分贝）
 */
function calculateVolume(buffer: Buffer): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 2) {
        const sample = buffer.readInt16LE(i);
        sum += sample * sample;
    }
    const rms = Math.sqrt(sum / (buffer.length / 2));
    // 转换为分贝 (dB)
    const maxAmplitude = 32767;
    if (rms === 0) return -Infinity;
    return 20 * Math.log10(rms / maxAmplitude);
}

/**
 * 检测是否有声音（基于音量阈值）
 */
function hasSound(volume: number, threshold: number = -40): boolean {
    return volume > threshold;
}

/**
 * 获取 Windows 上可用的音频设备列表
 */
function getWindowsAudioDevices(): Promise<string[]> {
    return new Promise((resolve) => {
        const command = getFfmpegPath();
        const process = spawn(command, ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        process.stderr?.on('data', (data: Buffer) => {
            output += data.toString();
        });

        process.on('close', () => {
            const devices: Array<{ name: string; altName?: string }> = [];
            const lines = output.split('\n');
            let inAudioSection = false;
            let currentDevice: { name?: string; altName?: string } = {};
            
            for (const line of lines) {
                if (line.includes('DirectShow audio devices')) {
                    inAudioSection = true;
                    continue;
                }
                if (inAudioSection && line.includes('DirectShow video devices')) {
                    break;
                }
                if (inAudioSection) {
                    const nameMatch = line.match(/"([^"]+)"/);
                    if (nameMatch && nameMatch[1]) {
                        const deviceName = nameMatch[1];
                        if (!deviceName.startsWith('@device_cm_')) {
                            if (currentDevice.name) {
                                devices.push({ name: currentDevice.name, altName: currentDevice.altName });
                            }
                            currentDevice = { name: deviceName };
                            const altMatch = line.match(/@device_cm_[^\s\)]+/);
                            if (altMatch) {
                                currentDevice.altName = altMatch[0];
                            }
                        } else {
                            currentDevice.altName = deviceName;
                        }
                    }
                }
            }
            if (currentDevice.name) {
                devices.push({ name: currentDevice.name, altName: currentDevice.altName });
            }
            
            const deviceNames: string[] = [];
            for (const d of devices) {
                if (d.name) {
                    deviceNames.push(d.name);
                }
                if (d.altName && !deviceNames.includes(d.altName)) {
                    deviceNames.push(d.altName);
                }
            }
            resolve(deviceNames);
        });

        process.on('error', () => {
            resolve([]);
        });
    });
}

const commonWindowsDeviceNames = [
    '麦克风',
    'Microphone',
    '麦克风 (Realtek Audio)',
    'Microphone (Realtek Audio)',
    '麦克风阵列',
    'Microphone Array',
    'default',
];

let recordingProcess: ChildProcess | null = null;
let isMonitoring = false;
let detectedDevices: string[] = [];
let currentDeviceIndex = 0;
let failedDevices: string[] = [];

// VAD 相关状态
let audioBuffer: Buffer[] = []; // 收集的音频数据（用于实时 ASR）
let isCollecting = false; // 是否正在收集音频
let lastSoundTime = 0; // 最后一次检测到声音的时间
let recordingStartTime = 0; // 开始录音的时间（毫秒时间戳）

// 实时 ASR 相关状态
let realtimeAsrWs: any = null; // 实时 ASR WebSocket 连接
let isRealtimeAsrActive = false; // 实时 ASR 是否激活
let currentTranscription = ''; // 当前转录文本
let asrConfig: any = null; // ASR 配置
let pendingTranscription: ((text: string) => void) | null = null; // 等待转录完成的回调
let connectPromise: { resolve: () => void; reject: (err: Error) => void } | null = null; // 等待连接建立的 Promise

// VAD 参数
const SOUND_THRESHOLD = -40; // 音量阈值 (dB)
const SILENCE_TIMEOUT = 1500; // 静音超时时间（毫秒），超过此时间认为停止说话
const MIN_RECORDING_DURATION = 0; // 最小录音时长（毫秒），设置为0表示不限制，只要有转录结果就发送

/**
 * 建立实时 ASR 连接（通过服务器代理）
 */
async function connectRealtimeAsr(): Promise<void> {
    if (isRealtimeAsrActive && realtimeAsrWs && realtimeAsrWs.readyState === WS.OPEN) {
        logger.debug('实时 ASR 连接已存在');
        return;
    }

    if (!WS) {
        throw new Error('缺少 ws 模块，请安装: npm install ws');
    }

    // 获取服务器的 WebSocket 地址
    const voiceClient = getVoiceClient();
    if (!voiceClient) {
        throw new Error('VoiceClient 未初始化，无法获取服务器地址');
    }

    const ws = (voiceClient as any).ws;
    if (!ws || !ws.url) {
        throw new Error('无法获取服务器地址');
    }

    // 从 Edge WebSocket URL 构造 ASR 代理 URL
    // 例如: wss://test.ejunz.com/edge/conn -> wss://test.ejunz.com/asr-proxy
    const edgeUrl = new URL(ws.url);
    const asrProxyUrl = `${edgeUrl.protocol === 'wss:' ? 'wss:' : 'ws:'}//${edgeUrl.host}/asr-proxy`;

    logger.info(`连接 ASR 代理服务: ${asrProxyUrl}`);

    // 使用默认 ASR 配置（服务器端会处理实际配置）
    asrConfig = {
        provider: 'qwen-realtime',
        enableServerVad: true,
        language: 'zh',
    };

    return new Promise((resolve, reject) => {
        try {
            connectPromise = { resolve, reject };
            realtimeAsrWs = new WS(asrProxyUrl);

            realtimeAsrWs.on('open', () => {
                logger.info('[实时ASR] 代理连接已建立，等待上游确认...');
                // 不立即发送session.update，等待connection.opened消息
                // sendSessionUpdate 会在收到 connection.opened 后调用
            });

            realtimeAsrWs.on('message', (message: Buffer | string) => {
                try {
                    const text = typeof message === 'string' ? message : message.toString('utf8');
                    const data = JSON.parse(text);
                    // 只记录重要消息类型，减少日志噪音
                    if (data.type && !data.type.includes('delta') && !data.type.includes('text')) {
                        logger.debug('[实时ASR] 收到消息: type=%s', data.type);
                    }
                    handleRealtimeAsrMessage(data);
                } catch (e: any) {
                    logger.error('[实时ASR] 解析消息失败: %s, raw=%s', e.message, 
                        typeof message === 'string' ? message.slice(0, 200) : message.toString('utf8').slice(0, 200));
                }
            });

            realtimeAsrWs.on('close', (code: number, reason: Buffer) => {
                logger.info(`[实时ASR] 连接关闭: ${code} - ${reason?.toString() || ''}`);
                isRealtimeAsrActive = false;
                realtimeAsrWs = null;
            });

            realtimeAsrWs.on('error', (err: Error) => {
                logger.error('[实时ASR] 连接错误: %s', err.message);
                isRealtimeAsrActive = false;
                realtimeAsrWs = null;
                if (connectPromise) {
                    connectPromise.reject(err);
                    connectPromise = null;
                }
            });
        } catch (e: any) {
            isRealtimeAsrActive = false;
            if (connectPromise) {
                connectPromise.reject(e);
                connectPromise = null;
            }
        }
    });
}

/**
 * 发送会话更新配置
 */
function sendSessionUpdate() {
    const enableServerVad = asrConfig.enableServerVad !== false;
    const language = asrConfig.language || 'zh';

    const eventVad = {
        event_id: `event_${Date.now()}`,
        type: 'session.update',
        session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            sample_rate: 16000,
            input_audio_transcription: {
                language
            },
            turn_detection: {
                type: 'server_vad',
                threshold: 0.2,
                silence_duration_ms: 800
            }
        }
    };

    const eventNoVad = {
        event_id: `event_${Date.now()}`,
        type: 'session.update',
        session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            sample_rate: 16000,
            input_audio_transcription: {
                language
            },
            turn_detection: null
        }
    };

    const event = enableServerVad ? eventVad : eventNoVad;
        // 会话配置已发送，不记录日志以减少噪音
    
    if (realtimeAsrWs && realtimeAsrWs.readyState === WS.OPEN) {
        realtimeAsrWs.send(JSON.stringify(event));
    }
}

/**
 * 发送音频块到实时 ASR
 */
function sendAudioToRealtimeAsr(chunk: Buffer) {
    if (!isRealtimeAsrActive || !realtimeAsrWs || realtimeAsrWs.readyState !== WS.OPEN) {
        logger.debug('[实时ASR] 跳过发送音频：连接未就绪 (active=%s, readyState=%s)', 
            isRealtimeAsrActive, realtimeAsrWs?.readyState);
        return;
    }

    try {
        const encoded = chunk.toString('base64');
        const appendEvent = {
            event_id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            type: 'input_audio_buffer.append',
            audio: encoded
        };

        realtimeAsrWs.send(JSON.stringify(appendEvent));
        // 只在debug模式下记录，避免日志过多
        // 音频块已发送，不记录日志以减少噪音
    } catch (e: any) {
        logger.error('[实时ASR] 发送音频失败: %s', e.message);
    }
}

/**
 * 提交音频并等待转录完成
 */
async function commitAndWaitTranscription(): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!asrConfig?.enableServerVad) {
            // Manual 模式，需要发送 commit 事件
            const commitEvent = {
                event_id: `event_${Date.now()}`,
                type: 'input_audio_buffer.commit'
            };
            
            if (realtimeAsrWs && realtimeAsrWs.readyState === WS.OPEN) {
                realtimeAsrWs.send(JSON.stringify(commitEvent));
                logger.debug('[实时ASR] 发送 commit 事件');
            }
        } else {
            // 服务器 VAD 模式，不发送 commit，等待自动检测
            logger.debug('[实时ASR] VAD 模式，等待自动检测完成...');
        }

        // 设置等待转录完成的回调
        pendingTranscription = (text: string) => {
            pendingTranscription = null;
            resolve(text);
        };

        // 超时处理（服务器 VAD 需要更长时间，使用8秒）
        const timeout = asrConfig?.enableServerVad ? 8000 : 5000;
        setTimeout(() => {
            if (pendingTranscription) {
                pendingTranscription = null;
                // 如果超时但有当前转录文本，使用它而不是失败
                if (currentTranscription && currentTranscription.trim()) {
                    logger.warn('[实时ASR] 转录超时，使用当前转录文本: %s', currentTranscription);
                    resolve(currentTranscription.trim());
                } else {
                    reject(new Error('转录超时且无转录文本'));
                }
            }
        }, timeout);
    });
}

/**
 * 处理实时 ASR 消息
 */
function handleRealtimeAsrMessage(data: any) {
    // 处理代理连接成功消息
    if (data.type === 'connection.opened') {
        logger.info('[实时ASR] 代理连接已确认，准备发送会话配置');
        // 确保在连接完全就绪后发送会话配置
        setTimeout(() => {
            sendSessionUpdate();
            isRealtimeAsrActive = true;
            // 连接建立完成，resolve promise
            if (connectPromise) {
                connectPromise.resolve();
                connectPromise = null;
            }
            logger.debug('[实时ASR] 连接完全就绪');
            
            // 如果有缓存的音频数据且正在收集中，现在发送它们
            if (audioBuffer.length > 0 && isCollecting) {
                logger.debug('[实时ASR] 发送 %d 个缓存的音频块', audioBuffer.length);
                for (const cachedChunk of audioBuffer) {
                    sendAudioToRealtimeAsr(cachedChunk);
                }
            }
        }, 100);
        return;
    }
    
    // 处理会话更新响应
    if (data.type === 'session.updated') {
        logger.debug('[实时ASR] 会话配置已确认');
        return;
    }

    // 处理实时转录更新
    if (data.type === 'conversation.item.input_audio_transcription.delta') {
        if (data.delta) {
            currentTranscription += data.delta;
        }
    }

    // 处理实时转录文本更新（Qwen ASR使用stash字段）
    if (data.type === 'conversation.item.input_audio_transcription.text') {
        const displayText = data.stash || data.text || '';
        if (displayText) {
            currentTranscription = displayText;
                // 实时转录更新，不记录日志以减少噪音
            // 如果有 pendingTranscription 且文本不为空，考虑提前完成（可选）
            // 注意：这里不提前完成，等待 completed 事件或超时
        }
    }

    // 处理转录完成
    if (data.type === 'conversation.item.input_audio_transcription.completed') {
        const finalText = data.transcript || currentTranscription;
        logger.info(`[实时ASR] 最终转录: ${finalText}`);
        
        if (pendingTranscription) {
            pendingTranscription(finalText);
        }
        
        // 重置转录文本
        currentTranscription = '';
    }

    // 处理连接关闭
    if (data.type === 'connection.closed') {
        logger.warn('[实时ASR] 连接已关闭: %s - %s', data.code, data.reason || '未知原因');
        isRealtimeAsrActive = false;
        realtimeAsrWs = null;
    }

    // 处理错误
    if (data.type === 'error') {
        logger.error('[实时ASR] 错误: %s', JSON.stringify(data));
        if (pendingTranscription) {
            pendingTranscription('');
            pendingTranscription = null;
        }
    }
}

/**
 * 发送转录文本到服务器进行 AI 对话
 */
async function sendTextToServer(text: string) {
    const voiceClient = getVoiceClient();
    if (!voiceClient) {
        logger.warn('VoiceClient 未初始化，无法发送文本');
        return;
    }

    const ws = (voiceClient as any).ws;
    if (!ws || ws.readyState !== 1) {
        logger.error('WebSocket未连接，无法发送文本');
        return;
    }

    const conversationHistory = (voiceClient as any).conversationHistory || [];
    
    const message = {
        key: 'voice_chat',
        text: text, // 直接发送文本，不发送音频
        format: 'text',
        conversationHistory: conversationHistory.slice(-10),
    };

    try {
        ws.send(JSON.stringify(message));
        logger.info('已发送转录文本到服务器进行 AI 对话: %s', text);
    } catch (e: any) {
        logger.error('发送文本失败: %s', e.message);
    }
}

/**
 * 发送收集的音频数据（使用实时 ASR）
 * 注意：音频已经在检测到声音时实时发送，这里只需要提交并等待转录
 */
async function sendCollectedAudio() {
    if (audioBuffer.length === 0) {
        logger.debug('没有收集到音频数据');
        return;
    }

    try {
        // 确保实时 ASR 连接已建立
        if (!isRealtimeAsrActive || !realtimeAsrWs || realtimeAsrWs.readyState !== WS.OPEN) {
            await connectRealtimeAsr();
            // 如果连接是新建立的，需要重新发送已收集的音频块
            logger.info('重新发送 %d 个音频块到实时 ASR', audioBuffer.length);
            for (const chunk of audioBuffer) {
                sendAudioToRealtimeAsr(chunk);
            }
        }

        // 提交并等待转录（音频已经在实时发送时发送过了）
        const transcribedText = await commitAndWaitTranscription();
        
        if (transcribedText && transcribedText.trim()) {
            // 发送转录文本到服务器
            await sendTextToServer(transcribedText);
        } else {
            logger.warn('[实时ASR] 转录结果为空，跳过发送');
        }

    } catch (err: any) {
        logger.error('处理音频失败: %s', err.message);
    } finally {
        // 清空缓冲区
        audioBuffer = [];
        currentTranscription = '';
    }
}

/**
 * 开始自动语音监听和交互
 */
async function startAutoVoiceMonitoring() {
    if (isMonitoring) {
        logger.debug('自动语音监听已在运行中');
        return;
    }

    const platform = os.platform();
    let command: string;
    let args: string[];

    if (platform === 'win32') {
        command = getFfmpegPath();
        let deviceName = '';
        
        const customDevice = process.env.RECORDING_DEVICE;
        if (customDevice) {
            deviceName = customDevice.includes('audio=') ? customDevice : `audio="${customDevice}"`;
        } else {
            if (detectedDevices.length === 0 || currentDeviceIndex >= detectedDevices.length) {
                logger.info('正在检测可用的音频设备...');
                detectedDevices = await getWindowsAudioDevices();
                currentDeviceIndex = 0;
                
                if (detectedDevices.length > 0) {
                    logger.info('检测到 %d 个音频设备: %s', detectedDevices.length, detectedDevices.join(', '));
                    const preferredIndex = detectedDevices.findIndex(d => {
                        const lower = d.toLowerCase();
                        return (d.includes('麦克风') || d.includes('Microphone') || lower.includes('mic')) &&
                               !lower.includes('streaming') && !lower.includes('virtual');
                    });
                    if (preferredIndex >= 0) {
                        currentDeviceIndex = preferredIndex;
                        logger.info('选择首选设备: %s', detectedDevices[preferredIndex]);
                    } else {
                        const nonVirtualIndex = detectedDevices.findIndex(d => {
                            const lower = d.toLowerCase();
                            return !lower.includes('streaming') && !lower.includes('virtual');
                        });
                        if (nonVirtualIndex >= 0) {
                            currentDeviceIndex = nonVirtualIndex;
                        }
                    }
                } else {
                    logger.warn('无法自动检测设备');
                }
            }
            
            if (detectedDevices.length > 0 && currentDeviceIndex < detectedDevices.length) {
                const micDevice = detectedDevices[currentDeviceIndex];
                if (micDevice.startsWith('@device_cm_')) {
                    deviceName = `audio=${micDevice}`;
                } else {
                    deviceName = `audio="${micDevice}"`;
                }
                logger.info('使用设备 [%d/%d]: %s', currentDeviceIndex + 1, detectedDevices.length, micDevice);
            } else {
                logger.warn('无法自动检测设备，尝试使用常见设备名称');
                const nextDevice = commonWindowsDeviceNames.find(d => !failedDevices.includes(d));
                if (nextDevice) {
                    deviceName = `audio="${nextDevice}"`;
                    logger.info('尝试设备: %s', nextDevice);
                } else {
                    logger.error('所有设备都失败，无法启动监听');
                    return;
                }
            }
        }
        
        args = [
            '-f', 'dshow',
            '-i', deviceName,
            '-ar', '16000',
            '-ac', '1',
            '-acodec', 'pcm_s16le',
            '-f', 's16le',
            '-',
        ];
    } else if (platform === 'darwin') {
        command = getFfmpegPath();
        args = [
            '-f', 'avfoundation',
            '-i', ':0',
            '-ar', '16000',
            '-ac', '1',
            '-acodec', 'pcm_s16le',
            '-f', 's16le',
            '-',
        ];
    } else {
        command = getFfmpegPath();
        args = [
            '-f', 'alsa',
            '-i', 'default',
            '-ar', '16000',
            '-ac', '1',
            '-acodec', 'pcm_s16le',
            '-f', 's16le',
            '-',
        ];
    }

    logger.info('开始自动语音监听...');
    isMonitoring = true;
    
    // 预先建立 ASR 连接，避免检测到声音时延迟
    if (!isRealtimeAsrActive || !realtimeAsrWs || realtimeAsrWs.readyState !== WS.OPEN) {
        logger.debug('预先建立实时 ASR 连接...');
        connectRealtimeAsr().catch((err) => {
            logger.warn('预先建立 ASR 连接失败，将在检测到声音时重试: %s', err.message);
        });
    }
    
    recordingProcess = spawn(command, args);

    const chunkSize = 3200; // 约0.1秒的PCM16音频 (16000 * 2 * 0.1)

    recordingProcess.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.length >= chunkSize) {
            const volume = calculateVolume(chunk);
            const hasSoundDetected = hasSound(volume, SOUND_THRESHOLD);
            const now = Date.now();

            if (hasSoundDetected) {
                // 检测到声音
                lastSoundTime = now;
                
                if (!isCollecting) {
                    // 开始收集音频
                    isCollecting = true;
                    audioBuffer = [];
                    currentTranscription = '';
                    recordingStartTime = now;
                    logger.info('检测到声音，开始录音 - 音量: %.2f dB', volume);
                    
                    // 确保实时 ASR 连接已建立（如果还没建立，尝试建立）
                    if (!isRealtimeAsrActive || !realtimeAsrWs || realtimeAsrWs.readyState !== WS.OPEN) {
                        logger.debug('ASR 连接未就绪，尝试建立连接...');
                        connectRealtimeAsr().catch((err) => {
                            logger.error('建立实时 ASR 连接失败: %s', err.message);
                        });
                    }
                }
                
                // 收集音频数据
                audioBuffer.push(chunk);
                
                // 如果 ASR 连接已就绪，立即发送音频
                if (isRealtimeAsrActive && realtimeAsrWs && realtimeAsrWs.readyState === WS.OPEN) {
                    sendAudioToRealtimeAsr(chunk);
                } else {
                    // 如果连接还未就绪，暂时缓存，等待连接建立后再发送
                    logger.debug('ASR 连接未就绪，音频已缓存，等待连接建立...');
                }
            } else {
                // 没有声音
                if (isCollecting) {
                    // 正在收集中，检查是否超过静音超时
                    const silenceTime = now - lastSoundTime;
                    
                    if (silenceTime >= SILENCE_TIMEOUT) {
                        // 静音时间超过阈值，停止收集并发送
                        // 计算录音时长：从开始收集到上次检测到声音的时间
                        const recordingDuration = Math.max(0, lastSoundTime - recordingStartTime);
                        logger.info('检测到静音，停止录音并发送 - 录音时长: %d ms', recordingDuration);
                        isCollecting = false;
                        // 直接发送，不再检查时长限制
                        sendCollectedAudio().catch((err) => {
                            logger.error('发送音频失败: %s', err.message);
                        });
                    } else {
                        // 静音时间未超时，继续收集（可能只是短暂的停顿）
                        audioBuffer.push(chunk);
                    }
                }
            }
        }
    });

    recordingProcess.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        if (str.toLowerCase().includes('error') || str.toLowerCase().includes('i/o error')) {
            logger.error('麦克风监听错误: %s', str.trim());
        }
    });

    recordingProcess.on('error', (err: Error) => {
        logger.error('启动麦克风监听失败: %s', err.message);
        isMonitoring = false;
    });

    recordingProcess.on('exit', (code: number) => {
        logger.warn('麦克风监听进程退出，代码: %s', code);
        isMonitoring = false;
        recordingProcess = null;
        
        if (code !== 0) {
            // 如果还有未发送的音频，尝试发送
            if (isCollecting && audioBuffer.length > 0) {
                logger.info('进程异常退出，尝试发送已收集的音频');
                sendCollectedAudio().catch((err) => {
                    logger.error('发送音频失败: %s', err.message);
                });
            }
            
            if (process.platform === 'win32' && !process.env.RECORDING_DEVICE) {
                if (detectedDevices.length > 0 && currentDeviceIndex < detectedDevices.length) {
                    const failedDevice = detectedDevices[currentDeviceIndex];
                    if (!failedDevices.includes(failedDevice)) {
                        failedDevices.push(failedDevice);
                        logger.warn('设备 "%s" 失败，标记为不可用', failedDevice);
                    }
                    currentDeviceIndex++;
                }
                
                setTimeout(() => {
                    logger.info('尝试重新启动自动语音监听...');
                    startAutoVoiceMonitoring().catch((err) => {
                        logger.error('重新启动失败: %s', err.message);
                    });
                }, 5000);
            }
        }
    });
}

function stopAutoVoiceMonitoring() {
    if (recordingProcess) {
        logger.info('停止自动语音监听...');
        recordingProcess.kill();
        recordingProcess = null;
        isMonitoring = false;
        isCollecting = false;
        audioBuffer = [];
    }
}

let connectionCheckInterval: NodeJS.Timeout | null = null;
let hasStarted = false;

export async function apply(ctx: Context) {
    // 等待 WebSocket 连接建立后再启动
    connectionCheckInterval = setInterval(() => {
        if (hasStarted) {
            return; // 已经启动，不再检查
        }

        const voiceClient = getVoiceClient();
        if (voiceClient) {
            const ws = (voiceClient as any).ws;
            if (ws && ws.readyState === 1) { // 1 = OPEN
                if (connectionCheckInterval) {
                    clearInterval(connectionCheckInterval);
                    connectionCheckInterval = null;
                }
                hasStarted = true;
                logger.info('上游连接已建立，开始初始化音频监听...');
                
                // 延迟一小段时间确保连接稳定
                setTimeout(async () => {
                    try {
                        await startAutoVoiceMonitoring();
                    } catch (err: any) {
                        logger.error('启动自动语音监听失败: %s', err.message);
                        hasStarted = false; // 允许重试
                    }
                }, 1000);
            }
        }
    }, 500);

    // 优雅关闭
    const cleanup = () => {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
            connectionCheckInterval = null;
        }
        stopAutoVoiceMonitoring();
        
        // 关闭实时 ASR 连接
        if (realtimeAsrWs && realtimeAsrWs.readyState === WS.OPEN) {
            try {
                realtimeAsrWs.close(1000, 'shutdown');
            } catch { /* ignore */ }
            realtimeAsrWs = null;
        }
        
        // 清理状态
        isRealtimeAsrActive = false;
        isMonitoring = false;
        isCollecting = false;
        audioBuffer = [];
        currentTranscription = '';
    };
    
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

