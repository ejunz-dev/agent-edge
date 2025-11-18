import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { getVoiceClient, getGlobalWsConnection, publishEvent } from './client';
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

// 流式传输状态（已移除音频收集模式）
let isStreaming = false; // 是否正在流式传输音频

// 实时 ASR 相关状态
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
 * 建立实时 ASR 连接（通过现有 WebSocket 事件系统）
 */
async function connectRealtimeAsr(): Promise<void> {
    if (isRealtimeAsrActive) {
        logger.debug('实时 ASR 连接已存在');
        return;
    }

    const ws = getGlobalWsConnection();
    if (!ws || ws.readyState !== 1) {
        throw new Error('WebSocket 未连接，无法建立 ASR 连接');
    }

    logger.info('[实时ASR] 通过现有 WebSocket 连接建立 ASR 服务');

    // 标记为已激活（配置由上游服务器提供，不需要客户端发送）
    isRealtimeAsrActive = true;
    
    // 立即完成连接（不需要发送会话配置，上游已有配置）
    if (connectPromise) {
        connectPromise.resolve();
        connectPromise = null;
    }
    logger.debug('[实时ASR] ASR 服务已就绪（配置由上游提供）');
}

/**
 * 发送会话更新配置（已废弃：配置由上游服务器提供）
 * 保留函数以防其他地方调用，但不执行任何操作
 */
function sendSessionUpdate() {
    // 配置由上游服务器提供，客户端不需要发送
    logger.debug('[实时ASR] 跳过发送会话配置（由上游提供）');
}

/**
 * 发送音频块到实时 ASR
 */
function sendAudioToRealtimeAsr(chunk: Buffer) {
    if (!isRealtimeAsrActive) {
        logger.debug('[实时ASR] 跳过发送音频：ASR 未激活');
        return;
    }

    const ws = getGlobalWsConnection();
    if (!ws || ws.readyState !== 1) {
        logger.debug('[实时ASR] 跳过发送音频：WebSocket 未连接');
        return;
    }

    try {
        const encoded = chunk.toString('base64');
        
        // 使用简单的格式，直接发送音频数据
        // 上游服务器期望 payload 中包含 audio 字段
        const audioEvent = {
            audio: encoded
        };

        // 通过事件系统发送音频数据
        publishEvent('client/asr/audio', [audioEvent]);
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
            
            const ws = getGlobalWsConnection();
            if (ws && ws.readyState === 1) {
                publishEvent('client/asr/commit', [commitEvent]);
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
 * 处理实时 ASR 消息（从事件系统接收）
 */
export function handleRealtimeAsrMessage(data: any) {
    // 处理会话更新响应（上游可能发送，但客户端不需要处理）
    if (data.type === 'session.updated') {
        logger.debug('[实时ASR] 收到会话配置确认（由上游管理）');
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
        
        // server已经自动转发转录文本到AI API，client不需要处理
        // 只更新currentTranscription用于显示
        currentTranscription = finalText;
        
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

    // 处理连接关闭（通过事件系统，不再需要单独处理）
    if (data.type === 'connection.closed') {
        logger.warn('[实时ASR] ASR 服务已关闭: %s - %s', data.code, data.reason || '未知原因');
        isRealtimeAsrActive = false;
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
        [Console]::Out.WriteLine("KEY_DOWN")
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds $checkInterval
        while ($true) {
            $state = [KeyCheck]::GetAsyncKeyState($mainKey)
            $stillPressed = ($state -band 0x8000) -ne 0
            if (-not $stillPressed) {
                [Console]::Out.WriteLine("KEY_UP")
                [Console]::Out.Flush()
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
        
        // 添加定期检查，确保进程还在运行
        const healthCheck = setInterval(() => {
            if (psProcess.killed || psProcess.exitCode !== null) {
                logger.warn('[键盘监听] PowerShell 进程已退出，代码: %s', psProcess.exitCode);
                clearInterval(healthCheck);
                return;
            }
        }, 5000);
        
        psProcess.stdout.on('data', (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === 'KEY_DOWN') {
                    if (!isListening) {
                        logger.info('🔔 按键按下，开始监听');
                        startListening().catch((err) => {
                            logger.error('开始监听失败: %s', err.message);
                        });
                    }
                } else if (trimmed === 'KEY_UP') {
                    if (isListening) {
                        logger.info('🔇 按键松开，停止监听');
                        stopListening();
                    }
                }
            }
        });
        
        // 完全忽略 stderr 输出，不注册任何处理函数
        // psProcess.stderr 的输出将被丢弃
        
        psProcess.on('error', (err: Error) => {
            logger.error('[键盘监听] PowerShell 进程错误: %s', err.message);
            clearInterval(healthCheck);
        });
        
        psProcess.on('exit', (code: number) => {
            logger.warn('[键盘监听] PowerShell 进程退出，代码: %s', code);
            clearInterval(healthCheck);
        });
        
        iohook = { process: psProcess, healthCheck };
        logger.info('✅ 键盘监听已启动（使用 PowerShell 回退方案）');
        logger.info('💡 提示：按下 %s 键开始监听，松开停止监听', listenKey);
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
    if (!isRealtimeAsrActive) {
        logger.warn('[实时ASR] ASR 未激活，尝试建立连接...');
        try {
            await connectRealtimeAsr();
            logger.info('[实时ASR] ASR 服务已就绪');
        } catch (err: any) {
            logger.error('建立 ASR 连接失败: %s', err.message);
            logger.error('请确保 ASR 连接在启动时已建立');
            return;
        }
    }
    
    const ws = getGlobalWsConnection();
    if (!ws || ws.readyState !== 1) {
        logger.error('WebSocket 未连接，无法开始监听');
        return;
    }
    
    isListening = true;
    isStreaming = true;
    
    // 确保录音设备已启动
    if (!isMonitoring || !recordingProcess) {
        logger.info('准备录音设备...');
        await startAutoVoiceMonitoring();
    }
    
    // 清空之前的转录结果
    currentTranscription = '';
    
    // 清除可能存在的部分数据
    if (recordingProcess && (recordingProcess as any)._partialChunk) {
        (recordingProcess as any)._partialChunk = Buffer.alloc(0);
    }
    
    // 发送开始标志给server
    notifyRecordingStarted();
    
    logger.info('🎤 开始流式录音');
}

/**
 * 停止监听（由键盘触发）
 */
function stopListening(): void {
    if (!isListening) {
        return;
    }
    
    // 立即停止流式传输
    isStreaming = false;
    
    logger.info('🔇 按键松开，等待剩余音频数据（300ms）...');
    
    // 等待 300ms，让剩余音频数据发送完成
    setTimeout(() => {
        isListening = false;
        
        // 发送停止标志给server，强制commit
        notifyRecordingCompleted();
        
        logger.info('🔇 停止流式录音');
    }, 300);
}

/**
 * 通知server录音已开始
 */
function notifyRecordingStarted() {
    const ws = getGlobalWsConnection();
    if (!ws || ws.readyState !== 1) {
        logger.debug('[实时ASR] WebSocket未连接，无法通知录音开始');
        return;
    }
    
    const notification = {
        type: 'recording.started',
        timestamp: Date.now()
    };
    
    try {
        publishEvent('client/asr/recording_started', [notification]);
        logger.debug('[实时ASR] 已通知server录音开始');
    } catch (err: any) {
        logger.error('[实时ASR] 通知录音开始失败: %s', err.message);
    }
}

/**
 * 通知server录音已完成，强制commit ASR识别
 */
function notifyRecordingCompleted() {
    const ws = getGlobalWsConnection();
    if (!ws || ws.readyState !== 1) {
        logger.debug('[实时ASR] WebSocket未连接，无法通知录音完成');
        return;
    }
    
    // 发送录音完成通知，让server强制commit
    const notification = {
        type: 'recording.completed',
        timestamp: Date.now()
    };
    
    try {
        publishEvent('client/asr/recording_completed', [notification]);
        logger.debug('[实时ASR] 已通知server录音完成，强制commit');
    } catch (err: any) {
        logger.error('[实时ASR] 通知录音完成失败: %s', err.message);
    }
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
        
    } catch (e: any) {
        logger.error('发送文本失败: %s', e.message);
    }
}

/**
 * 发送收集的音频数据（使用实时 ASR）
 * 注意：音频已经在检测到声音时实时发送，这里只需要提交并等待转录
 */
async function sendCollectedAudio() {
    // 流式模式：音频已实时发送，此函数已废弃，不再执行任何操作
    logger.debug('流式模式：sendCollectedAudio已废弃（音频已实时发送）');
    return;
    
    /* 以下代码已废弃，流式模式下不再需要
    try {
        // 确保实时 ASR 连接已建立
        if (!isRealtimeAsrActive) {
            logger.info('[实时ASR] ASR 未激活，正在建立连接...');
            await connectRealtimeAsr();
            logger.info('[实时ASR] ASR 服务已就绪');
        }
        
        const ws = getGlobalWsConnection();
        if (!ws || ws.readyState !== 1) {
            logger.error('WebSocket 未连接，无法开始监听');
            return;
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
        
        // 所有音频块发送完成后，通知server录音结束，强制commit
        notifyRecordingCompleted();
        
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
                
                // 定期检查是否收到转录文本（每100ms检查一次）
                const checkInterval = setInterval(() => {
                    // 如果已经收到转录结果，立即resolve
                    if (transcriptionReceived || transcribedText) {
                        clearTimeout(timeoutId);
                        clearInterval(checkInterval);
                        resolve();
                        return;
                    }
                    
                    // 检查 currentTranscription 是否有更新（可能在等待期间收到了text事件）
                    if (currentTranscription && currentTranscription.trim() && !transcriptionReceived) {
                        transcribedText = currentTranscription.trim();
                        transcriptionReceived = true;
                        logger.info('[实时ASR] 等待期间收到转录文本，立即使用: %s', transcribedText);
                        clearTimeout(timeoutId);
                        clearInterval(checkInterval);
                        if (pendingTranscription) {
                            pendingTranscription(transcribedText);
                            pendingTranscription = null;
                        }
                        isWaitingForTranscription = false;
                        resolve();
                        return;
                    }
                    
                    // pendingTranscription 被清空了，检查结果
                    if (!pendingTranscription && transcribedText) {
                        clearTimeout(timeoutId);
                        clearInterval(checkInterval);
                        resolve();
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
            // server已经自动转发转录文本到AI API，client不需要再发送
            // 只需要记录日志即可
        } else {
            logger.warn('[实时ASR] 转录结果为空');
        }

    } catch (err: any) {
        // server已经自动处理转录文本，client不需要处理超时后的发送
        // 只记录错误日志
        const audioDuration = '0'; // 流式模式：不计算音频时长
        if (audioDuration < '0.5') {
            logger.warn('处理音频失败: %s（音频时长仅%s秒，可能过短无法识别）', err.message, audioDuration);
        } else {
            logger.error('处理音频失败: %s', err.message);
        }
    } finally {
        // 清空音频缓冲区
        audioBuffer = [];
    }
    */
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
        // 流式传输模式：只在按键按下时实时发送音频块
        if (!isListening || !isStreaming) {
            return; // 按键未按下或已停止，忽略音频
        }
        
        // 处理部分chunk（累积到完整块）
        if (chunk.length < chunkSize) {
            if (!(recordingProcess as any)._partialChunk) {
                (recordingProcess as any)._partialChunk = Buffer.alloc(0);
            }
            (recordingProcess as any)._partialChunk = Buffer.concat([(recordingProcess as any)._partialChunk, chunk]);
            chunk = (recordingProcess as any)._partialChunk;
            if (chunk.length < chunkSize) {
                return; // 还不够一个完整块，继续累积
            }
            (recordingProcess as any)._partialChunk = Buffer.alloc(0);
        }
        
        if (chunk.length >= chunkSize) {
            // 流式发送：立即发送音频块到ASR服务器，不收集
            sendAudioToRealtimeAsr(chunk);
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
            // 流式模式：不需要处理收集的音频
            if (false) { // 已禁用
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
        // 流式模式：不需要这些变量
    }
}

let connectionCheckInterval: NodeJS.Timeout | null = null;
let connectionTimeout: NodeJS.Timeout | null = null;
let hasStarted = false;

export async function apply(ctx: Context) {
    // 设置超时：如果 10 秒内连接未建立，仍然启动键盘监听（允许离线使用）
    connectionTimeout = setTimeout(() => {
        if (hasStarted) {
            return;
        }
        logger.warn('上游连接超时（10秒），将启动键盘监听（可能无法发送到服务器）');
        hasStarted = true;
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
            connectionCheckInterval = null;
        }
        
        // 即使连接失败，也启动键盘监听
        (async () => {
            logger.info('开始初始化（上游连接未就绪）...');
            
            // 尝试预先建立 ASR 连接（可能失败，但不影响键盘监听）
            try {
                logger.info('[实时ASR] 正在尝试建立连接...');
                await connectRealtimeAsr();
                logger.info('[实时ASR] 连接已就绪（等待按键按下）');
            } catch (err: any) {
                logger.warn('[实时ASR] 连接失败: %s（将在按键按下时重试）', err.message);
            }
            
            // 初始化键盘监听（即使连接失败也可以使用）
            initKeyboardListener();
        })();
    }, 10000); // 10 秒超时
    
    // 等待 WebSocket 连接建立，并等待 VTube Studio 认证完成后再启动
    connectionCheckInterval = setInterval(() => {
        if (hasStarted) {
            return; // 已经启动，不再检查
        }

        // 优先使用 globalWsConnection，因为它更直接
        const globalWs = getGlobalWsConnection();
        const voiceClient = getVoiceClient();
        
        // 检查 WebSocket 连接状态（优先使用 globalWsConnection）
        const ws = globalWs || (voiceClient ? (voiceClient as any).ws : null);
        
        if (ws) {
            logger.debug('检查 WebSocket 状态: readyState=%s (1=OPEN)', ws.readyState);
        } else {
        if (voiceClient) {
                logger.debug('VoiceClient 存在但 ws 为 null，等待 ws 初始化...');
            } else {
                logger.debug('VoiceClient 和 globalWsConnection 都不存在，等待连接建立...');
            }
        }
        
            if (ws && ws.readyState === 1) { // 1 = OPEN
            logger.info('检测到 WebSocket 连接已建立，准备启动键盘监听...');
                if (connectionCheckInterval) {
                    clearInterval(connectionCheckInterval);
                    connectionCheckInterval = null;
                }
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }
                hasStarted = true;
                
            // 直接启动，不等待 VTube Studio 认证
                (async () => {
                // 检查配置，如果 VTube Studio 未启用，直接跳过
                    try {
                    const voiceConfig = config.voice || {};
                    const vtuberConfig = voiceConfig.vtuber || {};
                    
                    if (vtuberConfig.enabled !== true) {
                        logger.debug('VTube Studio 已禁用，直接启动语音监听服务');
                                } else {
                        logger.debug('VTube Studio 已启用，但不等待认证，直接启动语音监听服务');
                        }
                    } catch (err: any) {
                    logger.debug('检查 VTube Studio 配置失败，继续启动语音监听服务: %s', err.message);
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
    }, 500);

    // 优雅关闭
    const cleanup = () => {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
            connectionCheckInterval = null;
        }
        if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
        }
        stopAutoVoiceMonitoring();
        
        // 标记 ASR 为非激活状态（通过事件系统，不需要关闭连接）
        isRealtimeAsrActive = false;
        
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
                if (iohook.healthCheck) {
                    clearInterval(iohook.healthCheck);
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
        // 流式模式：不需要这些变量
        currentTranscription = '';
    };
    
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

