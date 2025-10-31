import { Logger } from '@ejunz/utils';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const logger = new Logger('voice-client');

// 动态引入ws模块
let WS: any;
try {
    WS = require('ws');
} catch {
    // ws可能未安装，后续会报错
}

// 动态引入ffmpeg安装器，获取ffmpeg可执行文件路径
let ffmpegPath: string | null = null;
let ffprobePath: string | null = null;
try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpegPath = ffmpegInstaller.path;
    logger.info('已加载通过 npm 安装的 ffmpeg: %s', ffmpegPath);
} catch {
    // @ffmpeg-installer/ffmpeg 可能未安装，将使用系统 PATH 中的 ffmpeg
    logger.debug('未找到 @ffmpeg-installer/ffmpeg，将使用系统 PATH 中的 ffmpeg');
}

try {
    const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
    ffprobePath = ffprobeInstaller.path;
    logger.info('已加载通过 npm 安装的 ffprobe: %s', ffprobePath);
} catch {
    // ffprobe 不是必须的，只是用来检测，不影响功能
}

export interface VoiceClientOptions {
    ws: any; // WebSocket connection
    audioFormat?: string; // 'wav', 'mp3', etc.
    sampleRate?: number;
    channels?: number;
}

/**
 * 获取 ffmpeg 可执行文件路径
 * 优先使用通过 npm 安装的版本，否则使用系统 PATH 中的版本
 */
function getFfmpegPath(): string {
    if (ffmpegPath) {
        return ffmpegPath;
    }
    return 'ffmpeg'; // fallback 到系统 PATH
}

/**
 * 获取 ffplay 可执行文件路径
 * ffplay 通常和 ffmpeg 在同一个目录
 */
function getFfplayPath(): string {
    if (ffmpegPath) {
        // ffplay 通常和 ffmpeg 在同一个目录
        const ffmpegDir = path.dirname(ffmpegPath);
        const ffplayPath = path.join(ffmpegDir, os.platform() === 'win32' ? 'ffplay.exe' : 'ffplay');
        // 检查文件是否存在
        if (fs.existsSync(ffplayPath)) {
            return ffplayPath;
        }
    }
    return 'ffplay'; // fallback 到系统 PATH
}

export class VoiceClient extends EventEmitter {
    private ws: any; // 到edge server的连接
    private audioFormat: string;
    private sampleRate: number;
    private channels: number;
    private recordingProcess: ChildProcess | null = null;
    private isRecording = false;
    private conversationHistory: Array<{ role: string; content: string }> = [];
    
    // 实时ASR相关
    private realtimeAsrWs: any = null; // Qwen-ASR WebSocket连接
    private isRealtimeMode = false;
    private realtimeAsrConfig: any = null;
    private audioChunkQueue: Buffer[] = [];
    private isSendingAudio = false;
    private currentTranscription = '';

    constructor(options: VoiceClientOptions) {
        super();
        this.ws = options.ws;
        this.audioFormat = options.audioFormat || 'wav';
        this.sampleRate = options.sampleRate || 16000;
        this.channels = options.channels || 1;

        // 监听WebSocket消息
        if (this.ws && typeof this.ws.on === 'function') {
            this.ws.on('message', (data: any) => {
                this.handleMessage(data);
            });
        }
    }

    private handleMessage(data: any) {
        try {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            const msg = JSON.parse(text);
            
            if (msg.key === 'voice_chat') {
                if (msg.error) {
                    logger.error('语音对话错误: %s', msg.error);
                    this.emit('error', new Error(msg.error));
                } else if (msg.result) {
                    const { text: transcribedText, audio, aiResponse } = msg.result;
                    logger.info('收到语音回复，文本: %s', aiResponse);
                    
                    // 更新对话历史
                    this.conversationHistory.push({ role: 'user', content: transcribedText });
                    this.conversationHistory.push({ role: 'assistant', content: aiResponse });
                    
                    // 播放音频
                    if (audio) {
                        this.playAudio(audio).catch((e) => {
                            logger.error('播放音频失败: %s', e.message);
                            this.emit('error', e);
                        });
                    }
                    
                    this.emit('response', { text: transcribedText, aiResponse, audio });
                }
            } else if (msg.key === 'voice_asr') {
                if (msg.error) {
                    logger.error('ASR错误: %s', msg.error);
                    this.emit('error', new Error(msg.error));
                } else if (msg.result) {
                    this.emit('transcription', msg.result.text);
                }
            } else if (msg.key === 'voice_tts') {
                if (msg.error) {
                    logger.error('TTS错误: %s', msg.error);
                    this.emit('error', new Error(msg.error));
                } else if (msg.result && msg.result.audio) {
                    this.playAudio(msg.result.audio).catch((e) => {
                        logger.error('播放音频失败: %s', e.message);
                        this.emit('error', e);
                    });
                    this.emit('tts', msg.result.audio);
                }
            }
        } catch (e: any) {
            logger.warn('处理消息失败: %s', e.message);
        }
    }

    /**
     * 开始录音
     */
    startRecording(): Promise<void> {
        if (this.isRecording) {
            logger.warn('已经在录音中');
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            try {
                // 使用系统录音工具（适用于Linux/Mac）
                // Linux: arecord, Mac: rec (from SoX), Windows: 需要其他工具
                const platform = os.platform();
                let command: string;
                let args: string[];

                if (platform === 'linux') {
                    // 使用 arecord (ALSA)
                    command = 'arecord';
                    args = [
                        '-f', 'S16_LE', // 16-bit little-endian
                        '-r', this.sampleRate.toString(),
                        '-c', this.channels.toString(),
                        '-t', this.audioFormat,
                        '-D', 'default', // 使用默认音频设备
                    ];
                } else if (platform === 'darwin') {
                    // macOS 使用 rec (SoX)
                    command = 'rec';
                    args = [
                        '-t', this.audioFormat,
                        '-r', this.sampleRate.toString(),
                        '-c', this.channels.toString(),
                        '-',
                    ];
                } else if (platform === 'win32') {
                    // Windows 使用 ffmpeg（通过 npm 安装或系统 PATH）
                    command = getFfmpegPath();
                    
                    // 支持自定义设备，如果没有指定则尝试常见的设备名称
                    // 用户可以通过环境变量 RECORDING_DEVICE 指定设备名称
                    // 查看可用设备：ffmpeg -list_devices true -f dshow -i dummy
                    let deviceName = 'audio="麦克风"'; // 中文系统默认
                    const customDevice = process.env.RECORDING_DEVICE;
                    if (customDevice) {
                        // 如果用户已经提供了完整的格式，直接使用
                        if (customDevice.includes('audio=')) {
                            deviceName = customDevice;
                        } else {
                            // 否则添加 audio= 前缀
                            deviceName = `audio=${customDevice}`;
                        }
                    }
                    
                    args = [
                        '-f', 'dshow', // DirectShow 输入格式（Windows）
                        '-i', deviceName,
                        '-ar', this.sampleRate.toString(), // 采样率
                        '-ac', this.channels.toString(), // 声道数
                        '-acodec', 'pcm_s16le', // PCM 16-bit little-endian
                        '-f', 'wav', // 输出格式
                        '-', // 输出到 stdout
                    ];
                } else {
                    // 其他平台尝试使用 ffmpeg（跨平台）
                    command = getFfmpegPath();
                    args = [
                        '-f', 'alsa', // Linux 默认
                        '-i', 'default',
                        '-ar', this.sampleRate.toString(),
                        '-ac', this.channels.toString(),
                        '-acodec', 'pcm_s16le',
                        '-f', 'wav',
                        '-',
                    ];
                }

                logger.info('开始录音...');
                this.isRecording = true;
                
                // 创建临时文件存储音频
                const tmpFile = path.join(os.tmpdir(), `voice-${Date.now()}.${this.audioFormat}`);
                
                // 录音进程
                this.recordingProcess = spawn(command, args);
                
                const chunks: Buffer[] = [];
                
                if (this.recordingProcess.stdout) {
                    this.recordingProcess.stdout.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
                    });
                }
                
                if (this.recordingProcess.stderr) {
                    this.recordingProcess.stderr.on('data', (data: Buffer) => {
                        // arecord 会向 stderr 输出状态信息，这是正常的
                        logger.debug('录音进程输出: %s', data.toString());
                    });
                }
                
                this.recordingProcess.on('close', (code) => {
                    this.isRecording = false;
                    if (code !== 0 && code !== null) {
                        logger.warn('录音进程退出码: %d', code);
                    }
                });
                
                this.recordingProcess.on('error', (err) => {
                    this.isRecording = false;
                    const platform = os.platform();
                    if (platform === 'win32' && (err.message.includes('spawn ffmpeg') || err.message.includes('ENOENT'))) {
                        logger.error('录音失败: 未找到 ffmpeg 命令');
                        logger.error('ffmpeg 将通过 npm 依赖自动安装，请运行: yarn install 或 npm install');
                        logger.error('如果仍然失败，请手动安装 ffmpeg:');
                        logger.error('1. 从 https://ffmpeg.org/download.html 下载 Windows 版本');
                        logger.error('2. 解压后将 bin 目录添加到系统 PATH 环境变量');
                        logger.error('3. 或使用 chocolatey: choco install ffmpeg');
                        reject(new Error('未找到 ffmpeg，请运行 yarn install 安装依赖，或手动安装 ffmpeg'));
                    } else {
                        logger.error('录音进程错误: %s', err.message);
                        reject(err);
                    }
                });

                // 存储录音数据
                const writeStream = fs.createWriteStream(tmpFile);
                if (this.recordingProcess.stdout) {
                    this.recordingProcess.stdout.pipe(writeStream);
                }

                // 保存临时文件路径以便停止时读取
                (this.recordingProcess as any).tmpFile = tmpFile;
                (this.recordingProcess as any).chunks = chunks;

                this.emit('recordingStarted');
                resolve();
            } catch (e: any) {
                this.isRecording = false;
                reject(e);
            }
        });
    }

    /**
     * 停止录音并发送到服务器
     */
    stopRecordingAndSend(): Promise<void> {
        if (!this.isRecording || !this.recordingProcess) {
            logger.warn('当前没有在录音');
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            try {
                const platform = os.platform();
                
                // Windows 上使用 ffmpeg 时，需要通过 stdin 发送 'q' 来优雅停止
                // 其他平台使用 SIGINT
                if (platform === 'win32') {
                    try {
                        // 尝试优雅停止（发送 'q' 到 stdin）
                        if (this.recordingProcess!.stdin && !this.recordingProcess!.stdin.destroyed) {
                            this.recordingProcess!.stdin.write('q');
                            this.recordingProcess!.stdin.end();
                        } else {
                            // 如果 stdin 不可用，直接 kill
                            this.recordingProcess!.kill();
                        }
                    } catch (e) {
                        // 如果写入失败，直接 kill
                        this.recordingProcess!.kill();
                    }
                } else {
                    // Linux/Mac 使用 SIGINT
                    this.recordingProcess!.kill('SIGINT');
                }
                
                this.recordingProcess!.on('close', () => {
                    try {
                        const tmpFile = (this.recordingProcess as any)?.tmpFile;
                        if (tmpFile && fs.existsSync(tmpFile)) {
                            // 读取录音文件
                            const audioBuffer = fs.readFileSync(tmpFile);
                            logger.info('录音完成，大小: %d bytes', audioBuffer.length);
                            
                            // 编码为base64并发送
                            const audioBase64 = audioBuffer.toString('base64');
                            this.sendVoiceChat(audioBase64);
                            
                            // 清理临时文件
                            fs.unlinkSync(tmpFile);
                            
                            this.emit('recordingStopped');
                            resolve();
                        } else {
                            // 如果没有文件，尝试从chunks获取
                            const chunks = (this.recordingProcess as any)?.chunks || [];
                            if (chunks.length > 0) {
                                const audioBuffer = Buffer.concat(chunks);
                                const audioBase64 = audioBuffer.toString('base64');
                                this.sendVoiceChat(audioBase64);
                                this.emit('recordingStopped');
                                resolve();
                            } else {
                                reject(new Error('无法获取录音数据'));
                            }
                        }
                    } catch (e: any) {
                        reject(e);
                    } finally {
                        this.isRecording = false;
                        this.recordingProcess = null;
                    }
                });
            } catch (e: any) {
                this.isRecording = false;
                this.recordingProcess = null;
                reject(e);
            }
        });
    }

    /**
     * 发送语音消息到服务器进行完整对话流程
     */
    private sendVoiceChat(audioBase64: string) {
        if (!this.ws || this.ws.readyState !== 1) { // 1 = OPEN
            logger.error('WebSocket未连接');
            this.emit('error', new Error('WebSocket未连接'));
            return;
        }

        const message = {
            key: 'voice_chat',
            audio: audioBase64,
            format: this.audioFormat,
            conversationHistory: this.conversationHistory.slice(-10), // 只保留最近10轮对话
        };

        try {
            this.ws.send(JSON.stringify(message));
            logger.info('已发送语音消息到服务器');
            this.emit('sent');
        } catch (e: any) {
            logger.error('发送语音消息失败: %s', e.message);
            this.emit('error', e);
        }
    }

    /**
     * 播放base64编码的音频
     */
    private async playAudio(audioBase64: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const audioBuffer = Buffer.from(audioBase64, 'base64');
                const tmpFile = path.join(os.tmpdir(), `playback-${Date.now()}.mp3`);
                
                // 先保存为临时文件
                fs.writeFileSync(tmpFile, audioBuffer);
                
                // 使用系统播放器播放
                const platform = os.platform();
                let command: string;
                let args: string[];

                if (platform === 'linux') {
                    // 使用 aplay, mpg123, 或 ffplay
                    if (this.audioFormat === 'mp3' || tmpFile.endsWith('.mp3')) {
                        command = 'mpg123';
                        args = ['-q', tmpFile]; // -q 静默模式
                    } else {
                        command = 'aplay';
                        args = [tmpFile];
                    }
                } else if (platform === 'darwin') {
                    command = 'afplay';
                    args = [tmpFile];
                } else if (platform === 'win32') {
                    // Windows: 优先使用 ffplay（支持更多格式），fallback 到 PowerShell
                    // 首先尝试 ffplay
                    command = getFfplayPath();
                    args = [
                        '-nodisp', // 不显示窗口
                        '-autoexit', // 播放完自动退出
                        '-loglevel', 'quiet', // 静默模式
                        tmpFile
                    ];
                    // 如果 ffplay 不可用，将尝试 PowerShell（在 error 处理中）
                } else {
                    // 其他平台尝试 ffplay
                    command = getFfplayPath();
                    args = [
                        '-nodisp',
                        '-autoexit',
                        '-loglevel', 'quiet',
                        tmpFile
                    ];
                }

                const playProcess = spawn(command, args);
                
                playProcess.on('close', () => {
                    // 清理临时文件
                    try {
                        if (fs.existsSync(tmpFile)) {
                            fs.unlinkSync(tmpFile);
                        }
                    } catch { /* ignore */ }
                    resolve();
                });
                
                playProcess.on('error', (err) => {
                    // Windows 上如果 ffplay 失败，尝试使用 PowerShell
                    if (platform === 'win32' && (command.includes('ffplay') || command.endsWith('ffplay.exe'))) {
                        logger.warn('ffplay 不可用，尝试使用 PowerShell 播放');
                        try {
                            const psCommand = 'powershell';
                            const psArgs = ['-Command', `(New-Object Media.SoundPlayer "${tmpFile}").PlaySync()`];
                            const psProcess = spawn(psCommand, psArgs);
                            
                            psProcess.on('close', () => {
                                try {
                                    if (fs.existsSync(tmpFile)) {
                                        fs.unlinkSync(tmpFile);
                                    }
                                } catch { /* ignore */ }
                                resolve();
                            });
                            
                            psProcess.on('error', (psErr) => {
                                logger.error('PowerShell 播放也失败: %s', psErr.message);
                                try {
                                    if (fs.existsSync(tmpFile)) {
                                        fs.unlinkSync(tmpFile);
                                    }
                                } catch { /* ignore */ }
                                reject(new Error(`无法播放音频：ffplay 和 PowerShell 都不可用。请安装 ffmpeg 或确保 PowerShell 可用`));
                            });
                            
                            return; // 不 reject，让 PowerShell 尝试
                        } catch (fallbackErr) {
                            // fallback 也失败
                        }
                    }
                    
                    logger.error('播放失败: %s', err.message);
                    // 清理临时文件
                    try {
                        if (fs.existsSync(tmpFile)) {
                            fs.unlinkSync(tmpFile);
                        }
                    } catch { /* ignore */ }
                    reject(err);
                });
                
                // 如果命令不存在，立即失败
                playProcess.stderr?.on('data', (data: Buffer) => {
                    const errorText = data.toString();
                    if (errorText.includes('command not found') || errorText.includes('not found')) {
                        // Windows 上如果 ffplay 不存在，尝试 PowerShell
                        if (platform === 'win32' && (command.includes('ffplay') || command.endsWith('ffplay.exe'))) {
                            logger.warn('ffplay 命令不存在，尝试使用 PowerShell');
                            playProcess.kill();
                            
                            try {
                                const psCommand = 'powershell';
                                const psArgs = ['-Command', `(New-Object Media.SoundPlayer "${tmpFile}").PlaySync()`];
                                const psProcess = spawn(psCommand, psArgs);
                                
                                psProcess.on('close', () => {
                                    try {
                                        if (fs.existsSync(tmpFile)) {
                                            fs.unlinkSync(tmpFile);
                                        }
                                    } catch { /* ignore */ }
                                    resolve();
                                });
                                
                                psProcess.on('error', (psErr) => {
                                    logger.error('PowerShell 播放也失败: %s', psErr.message);
                                    try {
                                        if (fs.existsSync(tmpFile)) {
                                            fs.unlinkSync(tmpFile);
                                        }
                                    } catch { /* ignore */ }
                                    reject(new Error(`无法播放音频：ffplay 和 PowerShell 都不可用。请安装 ffmpeg 或确保 PowerShell 可用`));
                                });
                            } catch (fallbackErr) {
                                reject(new Error(`播放命令不存在: ${command}，请安装 ffmpeg 或确保 PowerShell 可用`));
                            }
                            return;
                        }
                        
                        logger.error('播放命令不存在: %s', command);
                        playProcess.kill();
                        reject(new Error(`播放命令不存在: ${command}，请安装相应的播放工具`));
                    }
                });
            } catch (e: any) {
                reject(e);
            }
        });
    }

    /**
     * 重置对话历史
     */
    resetConversation() {
        this.conversationHistory = [];
        logger.info('对话历史已重置');
    }

    /**
     * 获取对话历史
     */
    getConversationHistory(): Array<{ role: string; content: string }> {
        return [...this.conversationHistory];
    }

    /**
     * 开始实时录音（使用Qwen-ASR实时识别）
     * @param asrConfig ASR配置，包含provider, apiKey等
     */
    async startRealtimeRecording(asrConfig: any): Promise<void> {
        if (this.isRecording) {
            logger.warn('已经在录音中');
            return;
        }

        if (asrConfig.provider !== 'qwen-realtime') {
            throw new Error('实时录音仅支持 qwen-realtime provider');
        }

        if (!WS) {
            throw new Error('缺少 ws 依赖，请安装: npm install ws');
        }

        this.realtimeAsrConfig = asrConfig;
        this.isRealtimeMode = true;
        this.currentTranscription = '';

        // 建立Qwen-ASR WebSocket连接
        const model = asrConfig.model || 'qwen3-asr-flash-realtime';
        const baseUrl = asrConfig.baseUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
        const url = `${baseUrl}?model=${model}`;

        logger.info(`连接实时ASR服务: ${url}`);

        return new Promise((resolve, reject) => {
            try {
                this.realtimeAsrWs = new WS(url, {
                    headers: {
                        'Authorization': `Bearer ${asrConfig.apiKey}`,
                        'OpenAI-Beta': 'realtime=v1'
                    }
                });

                this.realtimeAsrWs.on('open', () => {
                    logger.info('[实时ASR] 连接已建立');
                    this.sendSessionUpdate(asrConfig);
                    // 启动录音和音频发送
                    this.startRealtimeAudioCapture();
                    this.emit('realtimeRecordingStarted');
                    resolve();
                });

                this.realtimeAsrWs.on('message', (message: Buffer | string) => {
                    try {
                        const text = typeof message === 'string' ? message : message.toString('utf8');
                        const data = JSON.parse(text);
                        this.handleRealtimeAsrMessage(data);
                    } catch (e: any) {
                        logger.error('[实时ASR] 解析消息失败: %s', e.message);
                    }
                });

                this.realtimeAsrWs.on('close', (code: number, reason: Buffer) => {
                    logger.info(`[实时ASR] 连接关闭: ${code} - ${reason?.toString() || ''}`);
                    this.isRealtimeMode = false;
                    this.realtimeAsrWs = null;
                    this.emit('realtimeRecordingStopped');
                });

                this.realtimeAsrWs.on('error', (err: Error) => {
                    logger.error('[实时ASR] 连接错误: %s', err.message);
                    this.isRealtimeMode = false;
                    this.realtimeAsrWs = null;
                    reject(err);
                });
            } catch (e: any) {
                this.isRealtimeMode = false;
                reject(e);
            }
        });
    }

    /**
     * 发送会话更新配置
     */
    private sendSessionUpdate(asrConfig: any) {
        const enableServerVad = asrConfig.enableServerVad !== false;
        const language = asrConfig.language || 'zh';

        const eventVad = {
            event_id: `event_${Date.now()}`,
            type: 'session.update',
            session: {
                modalities: ['text'],
                input_audio_format: 'pcm',
                sample_rate: this.sampleRate,
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
                sample_rate: this.sampleRate,
                input_audio_transcription: {
                    language
                },
                turn_detection: null
            }
        };

        const event = enableServerVad ? eventVad : eventNoVad;
        logger.info(`[实时ASR] 发送会话配置 (VAD: ${enableServerVad})`);
        
        if (this.realtimeAsrWs && this.realtimeAsrWs.readyState === WS.OPEN) {
            this.realtimeAsrWs.send(JSON.stringify(event));
        }
    }

    /**
     * 开始实时音频采集
     */
    private startRealtimeAudioCapture() {
        const platform = os.platform();
        let command: string;
        let args: string[];

        if (platform === 'linux') {
            command = 'arecord';
            args = [
                '-f', 'S16_LE', // PCM16
                '-r', this.sampleRate.toString(),
                '-c', this.channels.toString(),
                '-t', 'raw', // 原始PCM数据
            ];
        } else if (platform === 'darwin') {
            command = 'rec';
            args = [
                '-t', 'raw',
                '-r', this.sampleRate.toString(),
                '-c', this.channels.toString(),
                '-b', '16', // 16-bit
                '-',
            ];
        } else if (platform === 'win32') {
            // Windows 使用 ffmpeg 进行实时录音
            command = getFfmpegPath();
            // 支持自定义设备，如果没有指定则尝试常见的设备名称
            // 用户可以通过环境变量 RECORDING_DEVICE 指定设备名称
            // 查看可用设备：ffmpeg -list_devices true -f dshow -i dummy
            let deviceName = 'audio="麦克风"'; // 中文系统默认
            const customDevice = process.env.RECORDING_DEVICE;
            if (customDevice) {
                // 如果用户已经提供了完整的格式，直接使用
                if (customDevice.includes('audio=')) {
                    deviceName = customDevice;
                } else {
                    // 否则添加 audio= 前缀
                    deviceName = `audio=${customDevice}`;
                }
            }
            
            args = [
                '-f', 'dshow', // DirectShow 输入格式
                '-i', deviceName,
                '-ar', this.sampleRate.toString(), // 采样率
                '-ac', this.channels.toString(), // 声道数
                '-acodec', 'pcm_s16le', // PCM 16-bit little-endian
                '-f', 's16le', // 输出原始 PCM 格式
                '-', // 输出到 stdout
            ];
        } else {
            // 其他平台尝试使用 ffmpeg
            command = getFfmpegPath();
            args = [
                '-f', 'alsa',
                '-i', 'default',
                '-ar', this.sampleRate.toString(),
                '-ac', this.channels.toString(),
                '-acodec', 'pcm_s16le',
                '-f', 's16le',
                '-',
            ];
        }

        logger.info('开始实时音频采集...');
        this.isRecording = true;
        this.recordingProcess = spawn(command, args);

        const chunkSize = 3200; // 约0.1秒的PCM16音频 (16000 * 2 * 0.1)

        if (this.recordingProcess.stdout) {
            this.recordingProcess.stdout.on('data', (chunk: Buffer) => {
                if (this.isRealtimeMode && this.realtimeAsrWs?.readyState === WS.OPEN) {
                    // 将音频块加入队列
                    this.audioChunkQueue.push(chunk);
                    // 如果当前没有在发送，启动发送循环
                    if (!this.isSendingAudio) {
                        this.sendAudioChunks();
                    }
                }
            });
        }

        this.recordingProcess.on('error', (err) => {
            const platform = os.platform();
            if (platform === 'win32' && (err.message.includes('spawn ffmpeg') || err.message.includes('ENOENT'))) {
                logger.error('实时录音失败: 未找到 ffmpeg 命令');
                logger.error('ffmpeg 将通过 npm 依赖自动安装，请运行: yarn install 或 npm install');
                logger.error('如果仍然失败，请手动安装 ffmpeg:');
                logger.error('1. 从 https://ffmpeg.org/download.html 下载 Windows 版本');
                logger.error('2. 解压后将 bin 目录添加到系统 PATH 环境变量');
                logger.error('3. 或使用 chocolatey: choco install ffmpeg');
                this.isRecording = false;
                this.emit('error', new Error('未找到 ffmpeg，请运行 yarn install 安装依赖，或手动安装 ffmpeg'));
            } else {
                logger.error('录音进程错误: %s', err.message);
                this.isRecording = false;
                this.emit('error', err);
            }
        });

        this.recordingProcess.on('close', () => {
            this.isRecording = false;
            this.isSendingAudio = false;
            logger.info('录音进程已关闭');
        });
    }

    /**
     * 发送音频块到实时ASR服务
     */
    private sendAudioChunks() {
        if (!this.isRealtimeMode || !this.realtimeAsrWs || this.realtimeAsrWs.readyState !== WS.OPEN) {
            this.isSendingAudio = false;
            return;
        }

        if (this.audioChunkQueue.length === 0) {
            // 队列为空，等待更多数据
            setTimeout(() => this.sendAudioChunks(), 100);
            return;
        }

        this.isSendingAudio = true;
        const chunk = this.audioChunkQueue.shift();
        
        if (chunk) {
            const encoded = chunk.toString('base64');
            const appendEvent = {
                event_id: `event_${Date.now()}_${Math.random().toString(16).slice(2)}`,
                type: 'input_audio_buffer.append',
                audio: encoded
            };

            try {
                this.realtimeAsrWs.send(JSON.stringify(appendEvent));
                logger.debug(`[实时ASR] 发送音频块: ${chunk.length} bytes`);
            } catch (e: any) {
                logger.error('[实时ASR] 发送音频失败: %s', e.message);
            }
        }

        // 继续发送下一个块
        setTimeout(() => this.sendAudioChunks(), 50); // 每50ms发送一次，模拟实时流
    }

    /**
     * 处理实时ASR消息
     */
    private handleRealtimeAsrMessage(data: any) {
        logger.debug('[实时ASR] 收到消息: %s', JSON.stringify(data).slice(0, 200));

        // 处理实时转录更新
        if (data.type === 'conversation.item.input_audio_transcription.delta') {
            if (data.delta) {
                this.currentTranscription += data.delta;
                this.emit('realtimeTranscript', {
                    delta: data.delta,
                    full: this.currentTranscription
                });
            }
        }

        // 处理转录完成
        if (data.type === 'conversation.item.input_audio_transcription.completed') {
            const finalText = data.transcript || this.currentTranscription;
            logger.info(`[实时ASR] 最终转录: ${finalText}`);
            
            this.emit('realtimeTranscriptComplete', {
                text: finalText
            });

            // 转录完成后，发送到AI进行对话
            this.sendToAIAndGetResponse(finalText);

            // 关闭实时ASR连接
            this.stopRealtimeRecording();
        }

        // 处理错误
        if (data.type === 'error') {
            logger.error('[实时ASR] 错误: %s', JSON.stringify(data));
            this.emit('error', new Error(data.error?.message || '实时ASR错误'));
        }
    }

    /**
     * 发送转录文本到AI并获取回复
     */
    private async sendToAIAndGetResponse(text: string) {
        if (!this.ws || this.ws.readyState !== 1) {
            logger.error('Edge WebSocket未连接，无法发送到AI');
            return;
        }

        // 发送到edge server进行AI对话和TTS
        const message = {
            key: 'voice_chat',
            text: text, // 直接使用转录的文本，不传audio
            format: 'text',
            conversationHistory: this.conversationHistory.slice(-10),
        };

        try {
            this.ws.send(JSON.stringify(message));
            logger.info('已发送转录文本到服务器进行AI对话');
        } catch (e: any) {
            logger.error('发送文本失败: %s', e.message);
            this.emit('error', e);
        }
    }

    /**
     * 停止实时录音
     */
    stopRealtimeRecording(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.isRealtimeMode) {
                resolve();
                return;
            }

            // 停止录音进程
            if (this.recordingProcess) {
                const platform = os.platform();
                // Windows 上使用 ffmpeg 时，需要通过 stdin 发送 'q' 来优雅停止
                if (platform === 'win32') {
                    try {
                        if (this.recordingProcess.stdin && !this.recordingProcess.stdin.destroyed) {
                            this.recordingProcess.stdin.write('q');
                            this.recordingProcess.stdin.end();
                        } else {
                            this.recordingProcess.kill();
                        }
                    } catch (e) {
                        this.recordingProcess.kill();
                    }
                } else {
                    this.recordingProcess.kill('SIGINT');
                }
                this.recordingProcess = null;
            }

            this.isRecording = false;
            this.isSendingAudio = false;
            this.audioChunkQueue = [];

            // 如果是Manual模式，发送commit事件
            if (this.realtimeAsrWs && this.realtimeAsrWs.readyState === WS.OPEN) {
                if (!this.realtimeAsrConfig?.enableServerVad) {
                    const commitEvent = {
                        event_id: `event_${Date.now()}`,
                        type: 'input_audio_buffer.commit'
                    };
                    this.realtimeAsrWs.send(JSON.stringify(commitEvent));
                    logger.info('[实时ASR] 发送commit事件');
                }
                
                // 延迟关闭，等待服务端处理完成
                setTimeout(() => {
                    if (this.realtimeAsrWs) {
                        this.realtimeAsrWs.close(1000, 'Recording stopped');
                        this.realtimeAsrWs = null;
                    }
                    this.isRealtimeMode = false;
                    this.currentTranscription = '';
                    this.emit('realtimeRecordingStopped');
                    resolve();
                }, 500);
            } else {
                this.isRealtimeMode = false;
                this.currentTranscription = '';
                resolve();
            }
        });
    }
}

