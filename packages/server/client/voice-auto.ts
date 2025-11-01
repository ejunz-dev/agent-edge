import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { getVoiceClient } from './client';
import { config } from '../config';

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
let lastCompletedTime = 0; // 最后一次收到 completed 事件的时间（用于判断是否刚完成转录）
let isWaitingForTranscription = false; // 是否正在等待转录完成

// VAD 参数
const SOUND_THRESHOLD = -40; // 音量阈值 (dB)
const SILENCE_TIMEOUT = 1500; // 静音超时时间（毫秒），超过此时间认为停止说话
const MIN_RECORDING_DURATION = 0; // 最小录音时长（毫秒），设置为0表示不限制，只要有转录结果就发送

// 键盘控制配置
const keyboardConfig = (config as any).voice?.keyboard || {};
const listenKey = keyboardConfig.listenKey || 'Backquote'; // 监听按键，默认反引号键 `
const keyModifiers = keyboardConfig.modifiers || []; // 修饰键数组

let isListening = false; // 是否正在监听（由键盘控制）
let iohook: any = null; // 键盘监听实例
const pressedModifiers = new Set<number>(); // 当前按下的修饰键

logger.info('语音监听初始化 (按键控制: %s%s)', 
    keyModifiers.length > 0 ? `${keyModifiers.join('+')}+` : '', 
    listenKey);

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

        // 标记正在等待转录
        isWaitingForTranscription = true;
        
        // 设置等待转录完成的回调
        pendingTranscription = (text: string) => {
            pendingTranscription = null;
            isWaitingForTranscription = false;
            resolve(text);
        };

        // 超时处理（服务器 VAD 需要更长时间，使用8秒）
        const timeout = asrConfig?.enableServerVad ? 8000 : 5000;
        setTimeout(() => {
            if (pendingTranscription) {
                pendingTranscription = null;
                isWaitingForTranscription = false;
                // 如果超时但有当前转录文本，使用它而不是失败
                if (currentTranscription && currentTranscription.trim()) {
                    logger.debug('[实时ASR] 转录超时，使用当前转录文本: %s', currentTranscription);
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
        }
    }

    // 处理转录完成
    if (data.type === 'conversation.item.input_audio_transcription.completed') {
        const finalText = data.transcript || currentTranscription;
        logger.info(`[实时ASR] 最终转录: ${finalText}`);
        
        // 标记完成时间
        lastCompletedTime = Date.now();
        isWaitingForTranscription = false;
        
        if (pendingTranscription) {
            pendingTranscription(finalText);
            pendingTranscription = null;
        }
        
        // 如果不在监听状态（按键已松开），检查是否是新的转录结果
        // 如果是新结果（发送音频后收到的），可以自动发送
        // 但如果是旧的转录结果（在发送新音频之前收到的），应该忽略
        if (!isListening && finalText && finalText.trim()) {
            // 检查是否正在等待新的转录（通过 pendingTranscription 或 isWaitingForTranscription 判断）
            // 如果正在等待，说明这是新发送的音频的转录结果，可以自动发送
            if (isWaitingForTranscription || pendingTranscription) {
                logger.debug('[实时ASR] 检测到按键已松开，收到新转录结果，自动发送');
                sendTextToServer(finalText.trim()).catch((err) => {
                    logger.error('自动发送转录结果失败: %s', err.message);
                });
                // 清空转录文本和等待状态
                currentTranscription = '';
                isWaitingForTranscription = false;
                if (pendingTranscription) {
                    pendingTranscription(finalText.trim());
                    pendingTranscription = null;
                }
            } else {
                // 如果没有在等待新的转录，说明这可能是旧的转录结果，保存但不自动发送
                // sendCollectedAudio 会检查并决定是否使用
                logger.debug('[实时ASR] 收到转录结果，但未在等待新转录，保存供后续检查: %s', finalText.trim());
                currentTranscription = finalText;
            }
        } else {
            // 在监听状态，保存转录结果供后续使用
            currentTranscription = finalText;
        }
    }
    
    // 处理新的语音开始（speech_started）
    // 如果刚刚完成了一次转录（500ms内），且不在监听状态，忽略这个新的 speech_started
    // 避免按键松开后的噪音导致新的转录等待
    if (data.type === 'input_audio_buffer.speech_started') {
        const timeSinceLastCompleted = Date.now() - lastCompletedTime;
        if (!isListening && timeSinceLastCompleted < 500 && currentTranscription) {
            logger.debug('[实时ASR] 忽略按键松开后的新语音检测（可能是噪音）');
            // 清空当前的转录文本，避免与新检测冲突
            currentTranscription = '';
        }
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
 * 将按键名称转换为 Windows 虚拟键码 (VK)
 */
function getVirtualKeyCode(keyName: string): number | null {
    // Windows 虚拟键码映射表
    const keyMap: { [key: string]: number } = {
        'Space': 0x20, // VK_SPACE
        'Enter': 0x0D, // VK_RETURN
        'Backspace': 0x08, // VK_BACK
        'Delete': 0x2E, // VK_DELETE
        'Tab': 0x09, // VK_TAB
        'Escape': 0x1B, // VK_ESCAPE
        'Up': 0x26, // VK_UP
        'Down': 0x28, // VK_DOWN
        'Left': 0x25, // VK_LEFT
        'Right': 0x27, // VK_RIGHT
        'Home': 0x24, // VK_HOME
        'End': 0x23, // VK_END
        'PageUp': 0x21, // VK_PRIOR
        'PageDown': 0x22, // VK_NEXT
        'F1': 0x70, 'F2': 0x71, 'F3': 0x72, 'F4': 0x73,
        'F5': 0x74, 'F6': 0x75, 'F7': 0x76, 'F8': 0x77,
        'F9': 0x78, 'F10': 0x79, 'F11': 0x7A, 'F12': 0x7B,
        'Control': 0x11, 'Ctrl': 0x11, // VK_CONTROL
        'Alt': 0xA4, 'LeftAlt': 0xA4, 'LAlt': 0xA4, // VK_LMENU (左 Alt)
        'RightAlt': 0xA5, 'RAlt': 0xA5, // VK_RMENU (右 Alt)
        'Shift': 0x10, // VK_SHIFT
        'Meta': 0x5B, 'Windows': 0x5B, 'Command': 0x5B, // VK_LWIN
        'Backquote': 0xC0, '`': 0xC0, 'Grave': 0xC0, // VK_OEM_3 (反引号键 `)
    };
    
    // 字母键 (A-Z) - VK_A = 0x41
    if (keyName.length === 1 && /^[A-Z]$/.test(keyName)) {
        return keyName.charCodeAt(0);
    }
    
    // 数字键 (0-9) - VK_0 = 0x30
    if (keyName.length === 1 && /^[0-9]$/.test(keyName)) {
        return keyName.charCodeAt(0);
    }
    
    return keyMap[keyName] || null;
}

/**
 * 将按键名称转换为 Electron globalShortcut 格式
 */
function getElectronAccelerator(keyName: string, modifiers: string[]): string {
    // Electron 支持的修饰键
    const electronModifiers = modifiers.map(mod => {
        const lower = mod.toLowerCase();
        if (lower === 'control' || lower === 'ctrl') return 'CommandOrControl';
        if (lower === 'alt') return 'Alt';
        if (lower === 'shift') return 'Shift';
        if (lower === 'meta' || lower === 'windows' || lower === 'command') return 'Meta';
        return null;
    }).filter(Boolean);
    
    // 主键转换
    let mainKey = keyName;
    if (keyName === 'Space') mainKey = 'Space';
    else if (keyName === 'Alt' || keyName === 'LeftAlt' || keyName === 'LAlt') {
        // Alt 键在 Electron 中作为修饰键，但如果单独使用，也支持
        mainKey = 'Alt';
    }
    else if (keyName.length === 1 && /^[A-Z]$/.test(keyName)) mainKey = keyName;
    else if (keyName.length === 1 && /^[0-9]$/.test(keyName)) mainKey = keyName;
    else if (keyName.startsWith('F') && /^\d+$/.test(keyName.slice(1))) mainKey = keyName; // F1-F12
    else {
        // 其他特殊键映射
        const keyMap: { [key: string]: string } = {
            'Enter': 'Return',
            'Backspace': 'Backspace',
            'Delete': 'Delete',
            'Tab': 'Tab',
            'Escape': 'Escape',
            'Up': 'Up',
            'Down': 'Down',
            'Left': 'Left',
            'Right': 'Right',
            'Home': 'Home',
            'End': 'End',
            'PageUp': 'PageUp',
            'PageDown': 'PageDown',
            'Backquote': '`',
            '`': '`',
            'Grave': '`',
        };
        mainKey = keyMap[keyName] || keyName;
    }
    
    // 组合成 accelerator 字符串
    const parts = [...electronModifiers, mainKey];
    return parts.join('+');
}

/**
 * 初始化键盘监听（使用 Electron globalShortcut API）
 */
function initKeyboardListener(): void {
    try {
        // 尝试使用 Electron 的 globalShortcut API
        const electron = require('electron');
        
        // 检查是否在 Electron 环境中
        if (!electron.globalShortcut) {
            throw new Error('Electron globalShortcut API 不可用');
        }
        
        // 获取 accelerator 字符串
        const accelerator = getElectronAccelerator(listenKey, keyModifiers);
        logger.info('初始化键盘监听: %s', accelerator);
        
        // 注册全局快捷键：按下时开始监听，再次按下时停止监听（切换模式）
        const registered = electron.globalShortcut.register(accelerator, () => {
            if (!isListening) {
                logger.info('🔔 按键按下，开始监听');
                startListening().catch((err) => {
                    logger.error('开始监听失败: %s', err.message);
                });
            } else {
                // 如果正在监听，再次按下时停止监听
                logger.info('🔇 按键再次按下，停止监听');
                stopListening();
            }
        });
        
        if (!registered) {
            throw new Error(`无法注册快捷键: ${accelerator}`);
        }
        
        logger.info('✅ 键盘监听已启动（使用 Electron globalShortcut）');
        logger.info('💡 提示：按住 %s 开始监听，再次按下停止监听', accelerator);
        
        iohook = { 
            electron, 
            accelerator, 
            registered
        };
        
    } catch (err: any) {
        logger.error('初始化键盘监听失败: %s', err.message);
        logger.debug('错误详情: %s', err.stack);
        logger.warn('回退到 PowerShell 轮询方式');
        
        // 回退到 PowerShell 方案
        initKeyboardListenerFallback();
    }
}

/**
 * 回退方案：使用 PowerShell 轮询（当 Electron 不可用时）
 */
function initKeyboardListenerFallback(): void {
    if (process.platform !== 'win32') {
        logger.warn('键盘监听功能目前仅支持 Windows 系统');
        return;
    }
    
    try {
        const { spawn } = require('child_process');
        const mainKeyCode = getVirtualKeyCode(listenKey);
        if (!mainKeyCode) {
            logger.error('不支持的按键: %s，请检查配置', listenKey);
            return;
        }
        
        const modifierCodes: number[] = [];
        for (const mod of keyModifiers) {
            const modCode = getVirtualKeyCode(mod);
            if (modCode) modifierCodes.push(modCode);
        }
        
        const modifiersStr = modifierCodes.length > 0 ? `@(${modifierCodes.join(', ')})` : '@()';
        const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KeyCheck {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@
$mainKey = ${mainKeyCode}
$modifiers = ${modifiersStr}
$checkInterval = 50
while ($true) {
    $mainState = [KeyCheck]::GetAsyncKeyState($mainKey)
    $mainPressed = ($mainState -band 0x8000) -ne 0
    $modifiersPressed = $true
    if ($modifiers.Count -gt 0) {
        foreach ($mod in $modifiers) {
            $modState = [KeyCheck]::GetAsyncKeyState($mod)
            if (($modState -band 0x8000) -eq 0) {
                $modifiersPressed = $false
                break
            }
        }
    }
    if ($mainPressed -and $modifiersPressed) {
        Write-Host "KEY_DOWN"
        Start-Sleep -Milliseconds $checkInterval
        while ($true) {
            $state = [KeyCheck]::GetAsyncKeyState($mainKey)
            $stillPressed = ($state -band 0x8000) -ne 0
            if (-not $stillPressed) {
                Write-Host "KEY_UP"
                break
            }
            Start-Sleep -Milliseconds $checkInterval
        }
    }
    Start-Sleep -Milliseconds $checkInterval
}
`;
        
        const psProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let buffer = '';
        psProcess.stdout.on('data', (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === 'KEY_DOWN' && !isListening) {
                    logger.info('🔔 按键按下，开始监听');
                    startListening().catch((err) => logger.error('开始监听失败: %s', err.message));
                } else if (trimmed === 'KEY_UP' && isListening) {
                    logger.info('🔇 按键松开，停止监听');
                    stopListening();
                }
            }
        });
        
        iohook = { process: psProcess };
        logger.info('✅ 键盘监听已启动（使用 PowerShell 回退方案）');
    } catch (err: any) {
        logger.error('PowerShell 回退方案也失败: %s', err.message);
    }
}

/**
 * 开始监听（由键盘触发）
 */
async function startListening(): Promise<void> {
    if (isListening) {
        return;
    }
    
    // 检查 ASR 连接是否已建立（应该在启动时已建立）
    if (!isRealtimeAsrActive || !realtimeAsrWs || realtimeAsrWs.readyState !== WS.OPEN) {
        logger.warn('[实时ASR] 连接未就绪，尝试建立连接...');
        try {
            await connectRealtimeAsr();
            logger.info('[实时ASR] 连接已建立');
        } catch (err: any) {
            logger.error('建立 ASR 连接失败: %s', err.message);
            logger.error('请确保 ASR 连接在启动时已建立');
            return;
        }
    }
    
    isListening = true;
    
    // 确保录音设备已启动
    if (!isMonitoring || !recordingProcess) {
        logger.info('准备录音设备...');
        await startAutoVoiceMonitoring();
    }
    
    // 清空之前的音频缓冲区和状态
    audioBuffer = [];
    currentTranscription = ''; // 清空之前的转录结果，确保使用新的结果
    isCollecting = false;
    lastSoundTime = 0;
    recordingStartTime = 0;
    isWaitingForTranscription = false; // 清空等待状态
    pendingTranscription = null; // 清空待处理的回调
    lastCompletedTime = 0; // 重置完成时间，避免被误判为刚完成的转录
    
    // 清除可能存在的部分数据
    if (recordingProcess && (recordingProcess as any)._partialChunk) {
        (recordingProcess as any)._partialChunk = Buffer.alloc(0);
    }
    
    logger.info('🎤 开始录音（ASR连接已就绪）');
}

/**
 * 停止监听（由键盘触发）
 */
function stopListening(): void {
    if (!isListening) {
        return;
    }
    
    logger.info('🔇 按键松开，等待剩余音频数据（300ms）...');
    
    // 等待 300ms，让录音进程的缓冲区数据有时间到达
    // 这样可以收集到完整的音频，避免只识别一半
    setTimeout(() => {
        // 现在真正停止监听和收集
        isListening = false;
        
        // 停止收集
        isCollecting = false;
        
        // 取消任何待处理的转录等待（避免超时错误）
        // 如果后面有 completed 事件，它会自动发送
        if (pendingTranscription) {
            // 如果有待处理的转录，先检查是否已有结果
            if (currentTranscription && currentTranscription.trim()) {
                const text = currentTranscription.trim();
                pendingTranscription(text);
                pendingTranscription = null;
                currentTranscription = '';
                logger.info('停止监听，使用已有转录结果: %s', text);
                sendTextToServer(text).catch((err) => {
                    logger.error('发送文本失败: %s', err.message);
                });
                // 清空音频缓冲区
                audioBuffer = [];
                logger.info('🔇 停止语音监听');
                return;
            } else {
                // 取消待处理的转录（设置为空字符串，避免超时错误）
                pendingTranscription('');
                pendingTranscription = null;
                logger.debug('停止监听，取消待处理的转录等待');
            }
        }
        
        // 检查是否已有待处理的转录结果（可能在 completed 事件中已经设置）
        if (currentTranscription && currentTranscription.trim()) {
            const text = currentTranscription.trim();
            logger.info('停止监听，使用已有转录结果: %s', text);
            currentTranscription = '';
            sendTextToServer(text).catch((err) => {
                logger.error('发送文本失败: %s', err.message);
            });
            // 清空音频缓冲区
            audioBuffer = [];
            logger.info('🔇 停止语音监听');
            return;
        }
        
        // 如果刚刚完成了一次转录（500ms内），不应该再发送新的音频
        const timeSinceLastCompleted = Date.now() - lastCompletedTime;
        if (timeSinceLastCompleted < 500) {
            logger.debug('停止监听，刚刚完成转录，跳过发送新音频');
            audioBuffer = [];
            logger.info('🔇 停止语音监听');
            return;
        }
        
        // 如果没有转录结果，且没有音频数据，直接返回
        if (audioBuffer.length === 0) {
            logger.debug('停止监听，没有音频数据');
            audioBuffer = [];
            logger.info('🔇 停止语音监听');
            return;
        }
        
        // 如果正在等待转录，且没有新的音频数据，不应该重复发送
        if (isWaitingForTranscription) {
            logger.debug('停止监听，正在等待转录完成，跳过重复发送');
            audioBuffer = [];
            logger.info('🔇 停止语音监听');
            return;
        }
        
        // 如果有音频数据，一次性发送所有收集的音频进行ASR处理
        if (audioBuffer.length > 0) {
            logger.info('停止监听，发送已收集的音频（共 %d 个音频块，约 %.1f 秒）', 
                audioBuffer.length, (audioBuffer.length * 0.1).toFixed(1));
            sendCollectedAudio().catch((err) => {
                logger.error('发送音频失败: %s', err.message);
                // 发送失败时清空缓冲区
                audioBuffer = [];
            });
        } else {
            logger.info('停止监听，没有收集到音频数据');
        }
        
        logger.info('🔇 停止语音监听');
    }, 300); // 等待 300ms 让剩余数据到达
}

/**
 * 发送转录文本到服务器进行 AI 对话
 */
async function sendTextToServer(text: string, isSystemMessage = false) {
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
        if (isSystemMessage) {
            logger.info('已发送系统消息: %s', text);
        } else {
            logger.info('已发送转录文本到服务器进行 AI 对话: %s', text);
        }
        
        // 消息已发送
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
            logger.info('[实时ASR] 连接未就绪，正在建立连接...');
            await connectRealtimeAsr();
            logger.info('[实时ASR] 连接已建立');
        }

        // 在开始发送新音频之前，清空之前的转录状态，确保不会使用上一次的结果
        const previousTranscription = currentTranscription;
        currentTranscription = ''; // 清空，准备接收新的转录结果
        isWaitingForTranscription = false;
        pendingTranscription = null;
        lastCompletedTime = 0; // 重置完成时间
        if (previousTranscription) {
            logger.debug('[实时ASR] 清空上一次的转录结果: %s', previousTranscription);
        }

        // 先设置等待转录的回调，这样在发送音频过程中收到的转录结果就能正确匹配
        let transcribedText: string | null = null;
        let transcriptionReceived = false;
        
        // 设置等待转录完成的回调（在发送音频之前设置，确保能捕获到新的转录结果）
        isWaitingForTranscription = true;
        pendingTranscription = (text: string) => {
            if (!transcriptionReceived) {
                transcriptionReceived = true;
                transcribedText = text;
                isWaitingForTranscription = false;
                pendingTranscription = null;
            }
        };

        // 模拟实时流式发送所有收集的音频块到实时 ASR
        // 每个音频块约0.1秒，所以按实际时间间隔发送，让服务器VAD能正确检测
        logger.info('[实时ASR] 流式发送 %d 个音频块到 ASR 服务器（总时长约 %.1f 秒）', 
            audioBuffer.length, (audioBuffer.length * 0.1).toFixed(1));
        
        // 计算总音频数据大小
        const totalSize = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
        logger.debug('[实时ASR] 总音频数据大小: %d 字节（%d KB）', totalSize, Math.round(totalSize / 1024));
        
        // 模拟实时发送：每个音频块之间间隔约100ms（0.1秒），保持原始时间间隔
        const chunkInterval = 100; // 每个块约0.1秒 = 100ms
        for (let i = 0; i < audioBuffer.length; i++) {
            const chunk = audioBuffer[i];
            
            // 使用setTimeout模拟实时发送时间间隔
            await new Promise<void>((resolve) => {
                setTimeout(() => {
                    sendAudioToRealtimeAsr(chunk);
                    resolve();
                }, i * chunkInterval);
            });
            
            // 每10个块记录一次进度
            if ((i + 1) % 10 === 0 || i === audioBuffer.length - 1) {
                logger.debug('[实时ASR] 已发送 %d/%d 个音频块', i + 1, audioBuffer.length);
            }
        }
        
        // 所有音频块发送完成后，立即检查是否有转录文本，有就立即使用，不管了
        // 提交音频（如果需要）
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
        }
        
        // 立即检查是否有转录文本（可能在发送过程中已经收到了）
        if (currentTranscription && currentTranscription.trim()) {
            // 已有转录文本，直接使用，不等待任何事件或定时器
            transcribedText = currentTranscription.trim();
            transcriptionReceived = true;
            logger.info('[实时ASR] 已有转录文本，立即使用: %s', transcribedText);
            
            // 清空状态
            currentTranscription = '';
            isWaitingForTranscription = false;
            if (pendingTranscription) {
                pendingTranscription(transcribedText);
                pendingTranscription = null;
            }
        } else {
            // 没有文本，等待 completed 事件或超时（作为后备）
            logger.info('[实时ASR] 没有转录文本，等待 completed 事件...');
            const timeout = asrConfig?.enableServerVad ? 8000 : 5000;
            await new Promise<void>((resolve) => {
                const timeoutId = setTimeout(() => {
                    if (!transcriptionReceived && pendingTranscription) {
                        pendingTranscription = null;
                        isWaitingForTranscription = false;
                    }
                    resolve();
                }, timeout);
                
                // 如果已经收到转录结果，立即resolve
                const checkInterval = setInterval(() => {
                    if (transcriptionReceived || transcribedText) {
                        clearTimeout(timeoutId);
                        clearInterval(checkInterval);
                        resolve();
                    } else if (!pendingTranscription) {
                        // pendingTranscription 被清空了，检查结果
                        if (transcribedText) {
                            clearTimeout(timeoutId);
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }
                }, 100);
            });
            
            // 超时后，如果还是没有，检查 currentTranscription，最后使用 commitAndWaitTranscription 作为后备
            if (!transcriptionReceived && !transcribedText) {
                if (currentTranscription && currentTranscription.trim()) {
                    transcribedText = currentTranscription.trim();
                    logger.info('[实时ASR] 超时但已有转录文本，使用当前文本: %s', transcribedText);
                } else {
                    logger.debug('[实时ASR] 超时未收到转录，使用 commitAndWaitTranscription 作为后备');
                    transcribedText = await commitAndWaitTranscription();
                }
            }
        }
        
        // 清理等待状态
        isWaitingForTranscription = false;
        pendingTranscription = null;
        
        if (transcribedText && transcribedText.trim()) {
            const text = transcribedText.trim();
            logger.info('[实时ASR] 获得转录结果: %s', text);
            // 发送转录文本到服务器进行对话
            await sendTextToServer(text);
        } else {
            logger.warn('[实时ASR] 转录结果为空，跳过发送');
        }

    } catch (err: any) {
        // 如果是超时错误，且已有转录文本，尝试使用它
        if (err.message.includes('转录超时') && currentTranscription && currentTranscription.trim()) {
            const text = currentTranscription.trim();
            logger.info('[实时ASR] 转录超时，使用已有转录文本: %s', text);
            currentTranscription = '';
            await sendTextToServer(text);
        } else {
            logger.error('处理音频失败: %s', err.message);
        }
    } finally {
        // 清空音频缓冲区
        audioBuffer = [];
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

    logger.info('准备录音设备（将在ASR连接就绪后启动）...');
    isMonitoring = true;
    
    // 启动录音设备进程
    recordingProcess = spawn(command, args);

    const chunkSize = 3200; // 约0.1秒的PCM16音频 (16000 * 2 * 0.1)

    recordingProcess.stdout?.on('data', (chunk: Buffer) => {
        // 只在按键按下时才处理音频
        // 注意：stopListening 会延迟 300ms 才设置 isListening = false
        // 这样可以在按键松开后继续收集剩余数据
        if (!isListening) {
            return; // 按键未按下或已停止，忽略音频
        }
        
        // 如果 chunk 长度不够，可能是部分数据，需要累积
        if (chunk.length < chunkSize) {
            // 如果已经有部分数据，累积起来
            if (!(recordingProcess as any)._partialChunk) {
                (recordingProcess as any)._partialChunk = Buffer.alloc(0);
            }
            (recordingProcess as any)._partialChunk = Buffer.concat([(recordingProcess as any)._partialChunk, chunk]);
            chunk = (recordingProcess as any)._partialChunk;
            if (chunk.length < chunkSize) {
                return; // 还不够一个完整块
            }
            (recordingProcess as any)._partialChunk = Buffer.alloc(0);
        }
        
        if (chunk.length >= chunkSize) {
            const volume = calculateVolume(chunk);
            const hasSoundDetected = hasSound(volume, SOUND_THRESHOLD);
            const now = Date.now();

            // 如果还没开始收集，立即开始收集（不等待检测到声音）
            if (!isCollecting) {
                // 按键按下后立即开始收集音频，无论是否有声音
                isCollecting = true;
                audioBuffer = [];
                currentTranscription = '';
                recordingStartTime = now;
                lastSoundTime = hasSoundDetected ? now : 0;
                if (hasSoundDetected) {
                    logger.info('检测到声音，开始录音 - 音量: %.2f dB', volume);
                } else {
                    logger.info('开始录音（等待声音）');
                }
                // 收集这个音频块
                audioBuffer.push(chunk);
            } else {
                // 已经开始收集，无论是否有声音都继续收集（直到按键松开）
                if (hasSoundDetected) {
                    lastSoundTime = now;
                }
                // 继续收集音频数据
                audioBuffer.push(chunk);
                // 每收集20个块记录一次（约2秒）
                if (audioBuffer.length % 20 === 0) {
                    logger.debug('收集音频块 [%d]，音量: %.2f dB', audioBuffer.length, volume);
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
    // 等待 WebSocket 连接建立，并等待 VTube Studio 认证完成后再启动
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
                
                // 异步等待 VTube Studio 认证完成后再启动
                (async () => {
                    // 检查 VTube Studio 是否已经认证完成（最多等待 30 秒）
                    try {
                        const { getVTubeStudioClient, waitForVTubeStudioAuthentication } = require('./vtuber-vtubestudio');
                        const vtsClient = getVTubeStudioClient();
                        
                        if (vtsClient) {
                            // 如果还没有认证，等待认证完成
                            if (!vtsClient.isConnected()) {
                                logger.info('等待 VTube Studio 认证完成后再启动语音监听服务（最多 30 秒）...');
                                const authenticated = await waitForVTubeStudioAuthentication(30000);
                                if (authenticated) {
                                    logger.info('✓ VTube Studio 认证完成，可以启动语音监听服务');
                                } else {
                                    logger.warn('VTube Studio 认证未完成（30秒超时），继续启动语音监听服务');
                                }
                            } else {
                                logger.debug('VTube Studio 已认证，可以启动语音监听服务');
                            }
                        } else {
                            logger.debug('VTube Studio 未启用，直接启动语音监听服务');
                        }
                    } catch (err: any) {
                        logger.debug('检查 VTube Studio 状态失败，继续启动语音监听服务: %s', err.message);
                    }
                    
                    logger.info('上游连接已建立，开始初始化...');
                    
                    // 预先建立 ASR 连接（不等待按键按下）
                    try {
                        logger.info('[实时ASR] 正在预先建立连接...');
                        await connectRealtimeAsr();
                        logger.info('[实时ASR] 连接已就绪（等待按键按下）');
                    } catch (err: any) {
                        logger.error('[实时ASR] 预先建立连接失败: %s', err.message);
                        // 继续执行，但不影响后续操作
                    }
                    
                    // 初始化键盘监听
                    initKeyboardListener();
                    
                    // 不在启动时立即启动录音设备，等待按键按下时在 startListening() 中启动
                })();
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
        
        // 停止键盘监听
        if (iohook) {
            try {
                if (iohook.electron && iohook.registered) {
                    // 使用 Electron globalShortcut
                    iohook.electron.globalShortcut.unregister(iohook.accelerator);
                    iohook.electron.globalShortcut.unregisterAll();
                }
                if (iohook.checkInterval) {
                    clearInterval(iohook.checkInterval);
                }
                if (iohook.process) {
                    iohook.process.kill();
                }
                iohook = null;
                logger.info('键盘监听已停止');
            } catch (err: any) {
                logger.error('停止键盘监听失败: %s', err.message);
            }
        }
        
        // 停止监听（如果正在监听）
        if (isListening) {
            stopListening();
        }
        
        // 清理修饰键状态
        pressedModifiers.clear();
        
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

