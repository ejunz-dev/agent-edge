import { Logger } from '@ejunz/utils';
import WebSocket = require('ws');
import * as fs from 'fs-extra';
import * as path from 'path';
import { VTuberControl } from './vtuber-server';

const logger = new Logger('vtuber-vtubestudio');

/**
 * VTube Studio API 客户端
 * 文档：https://github.com/DenchiSoft/VTubeStudio/wiki
 */
export class VTubeStudioClient {
    private ws: WebSocket | null = null;
    private currentAnimationInterval: NodeJS.Timeout | null = null;
    private currentAnimationQueue: Array<{ name: string; duration: number }> = []; // 动画序列队列
    private currentAnimationIndex: number = 0; // 当前播放的动画索引
    private currentAnimationMatched: boolean = false; // 记录当前动画是否成功匹配
    private isAuthenticated = false;
    private authToken: string | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 10;
    private readonly reconnectDelay = 3000; // 3秒
    private readonly host: string;
    private readonly port: number;
    private readonly apiName: string;
    private readonly apiVersion: string;
    private authenticationPromise: Promise<boolean> | null = null;
    private authenticationResolve: ((value: boolean) => void) | null = null;
    private authenticationReject: ((reason: any) => void) | null = null;
    private dbTokenLoaded = false;
    private warnedHotkeyMissing = false; // 是否已经警告过热键缺失
    private warnedParameterMissing = false; // 是否已经警告过参数缺失

    constructor(config?: {
        host?: string;
        port?: number;
        apiName?: string;
        apiVersion?: string;
        authToken?: string;
    }) {
        this.host = config?.host || '127.0.0.1';
        this.port = config?.port || 8001;
        this.apiName = config?.apiName || 'Agent Edge VTuber Control';
        this.apiVersion = config?.apiVersion || '1.0';
        // 如果提供了 authToken，直接使用；否则稍后从数据库加载
        this.authToken = (config?.authToken && config.authToken.trim() !== '') ? config.authToken : null;
    }
    
    /**
     * 从数据库加载认证令牌（异步）
     */
    async loadAuthToken(): Promise<void> {
        if (this.dbTokenLoaded || this.authToken) {
            return; // 已经加载或已有 token
        }
        
        this.dbTokenLoaded = true;
        const token = await this.loadAuthTokenFromDB();
        if (token) {
            this.authToken = token;
        }
    }

    /**
     * 连接到 VTube Studio
     */
    connect(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return;
        }

        const url = `ws://${this.host}:${this.port}`;
        logger.info('正在连接到 VTube Studio: %s', url);

        try {
            this.ws = new WebSocket(url);

            this.ws.on('open', async () => {
                logger.info('已连接到 VTube Studio');
                this.reconnectAttempts = 0;
                
                // 创建认证 Promise，等待认证完成
                this.authenticationPromise = new Promise((resolve, reject) => {
                    this.authenticationResolve = resolve;
                    this.authenticationReject = reject;
                });
                this.authenticate();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });

            this.ws.on('error', (err: Error) => {
                const errMsg = err.message;
                if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND')) {
                    if (this.reconnectAttempts === 0) {
                        logger.warn('无法连接到 VTube Studio (%s)', errMsg);
                        logger.info('提示：请确保 VTube Studio 已启动，并且 WebSocket API 已启用');
                        logger.info('当前尝试连接: ws://%s:%d', this.host, this.port);
                        logger.info('如果端口被占用，VTube Studio 可能使用了其他端口（8002、8003等），请在 VTube Studio 设置中查看实际端口号，并在配置文件中修改');
                    } else {
                    }
                } else {
                    logger.error('VTube Studio WebSocket 错误: %s', errMsg);
                }
            });

            this.ws.on('close', (code, reason) => {
                // 如果不是正常关闭（1000），且没有正在进行的重连，尝试重连
                if (code !== 1000 && !this.reconnectTimer) {
                    this.isAuthenticated = false;
                    this.attemptReconnect();
                } else if (code === 1000) {
                    // 正常关闭，不重连
                    this.isAuthenticated = false;
                    // 静默处理正常关闭
                }
            });
        } catch (err: any) {
            logger.error('连接 VTube Studio 失败: %s', err.message);
            this.attemptReconnect();
        }
    }

    /**
     * 认证请求
     */
    private authenticate(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // VTube Studio 要求 apiName 必须是 "VTubeStudioPublicAPI"
        const request: any = {
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '1.0',
            requestID: 'auth-request-' + Date.now(),
        };

        if (this.authToken) {
            // 使用已有令牌进行认证
            request.messageType = 'AuthenticationRequest';
            request.data = {
                authenticationToken: this.authToken,
                pluginName: this.apiName,
                pluginDeveloper: 'Agent Edge',
            };
            logger.info('使用已保存的认证令牌进行认证（如果失败将重新申请）');
        } else {
            // 首次认证，请求新令牌
            request.messageType = 'AuthenticationTokenRequest';
            request.data = {
                pluginName: this.apiName,
                pluginDeveloper: 'Agent Edge',
            };
            logger.info('首次认证，正在请求新的认证令牌（需要在 VTube Studio 中授权）');
        }

        this.send(request);
    }

    // 存储待处理的响应处理器（按 requestID）
    private pendingResponses: Map<string, (message: any) => void> = new Map();

    /**
     * 处理收到的消息
     */
    private handleMessage(data: WebSocket.Data): void {
        try {
            const message = JSON.parse(data.toString());

            // 先检查是否有待处理的响应处理器（优先级最高）
            if (message.requestID) {
                const handler = this.pendingResponses.get(message.requestID);
                if (handler) {
                    handler(message);
                    this.pendingResponses.delete(message.requestID);
                    return; // 已处理，不继续执行
                }
            }

            if (message.messageType === 'AuthenticationTokenResponse') {
                // 首次认证，收到认证令牌
                if (message.data?.authenticationToken) {
                    this.authToken = message.data.authenticationToken;
                    logger.info('收到认证令牌，正在使用令牌进行认证...');
                    // 保存令牌到配置文件
                    this.saveAuthToken();
                    // 使用收到的令牌立即进行认证请求
                    this.authenticate();
                    // 注意：认证结果会在 AuthenticationResponse 中处理
                } else {
                    logger.warn('需要用户授权：请在 VTube Studio 中授权此插件');
                    // 拒绝认证 Promise
                    if (this.authenticationReject) {
                        this.authenticationReject(new Error('需要用户授权'));
                        this.authenticationResolve = null;
                        this.authenticationReject = null;
                    }
                }
            } else if (message.messageType === 'AuthenticationResponse') {
                // 认证响应（使用令牌进行认证）
                if (message.data?.authenticated === true) {
                    this.isAuthenticated = true;
                    logger.info('✓ VTube Studio 认证成功');
                    // 确保 token 已保存（如果使用已有 token，此时 token 可能还未保存）
                    if (this.authToken) {
                        this.saveAuthToken();
                    }
                    // 解析认证 Promise
                    if (this.authenticationResolve) {
                        this.authenticationResolve(true);
                        this.authenticationResolve = null;
                        this.authenticationReject = null;
                    }
                    // 认证成功后，检查和报告配置
                    this.checkAndReportConfiguration();
                } else {
                    const errorMsg = message.data?.errorMessage || '未知错误';
                    logger.warn('认证失败: %s', errorMsg);
                    
                    // 如果使用已有 token 但认证失败，说明 token 可能已过期，清除并重新申请
                    const hadToken = !!this.authToken;
                    if (this.authToken) {
                        logger.info('认证令牌可能已失效，将清除并重新申请');
                        this.authToken = null;
                        this.saveAuthToken(); // 清除配置文件中的令牌
                        // 重新申请 token
                        setTimeout(() => {
                            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                                this.authenticate();
                            }
                        }, 1000);
                    }
                    
                    this.isAuthenticated = false;
                    // 拒绝认证 Promise（如果是因为使用已有 token 失败，已经在重新申请，不需要 reject）
                    if (this.authenticationReject && !hadToken) {
                        this.authenticationReject(new Error(errorMsg));
                        this.authenticationResolve = null;
                        this.authenticationReject = null;
                    }
                }
            } else if (message.messageType === 'ErrorResponse' || message.messageType === 'APIError') {
                // 处理 API 错误
                const errorMessage = message.data?.message || message.data?.errorMessage || message.message || '未知错误';
                const errorID = message.data?.errorID || message.errorID;
                
                // 根据错误类型选择日志级别
                // 453: 参数不存在（常见，静默处理）
                // 202: 热键不存在（常见，静默处理或仅警告一次）
                if (errorID === 453) {
                    // 参数不存在 - 静默处理
                    // 这是正常情况，因为参数是可选的，不需要每次报错
                    if (!this.warnedParameterMissing && errorMessage.includes('Parameter') && errorMessage.includes('not found')) {
                        this.warnedParameterMissing = true;
                        // 可选：在启动时提示一次即可，运行时不再提示
                    }
                } else if (errorID === 202) {
                    // 热键不存在 - 静默处理（热键是用户可选的，这是正常情况）
                    // 动画触发时会显示清晰的日志，不需要额外警告
                } else {
                    // 其他错误（认证错误等）使用 error 级别
                    logger.error('VTube Studio API 错误 (ID: %s): %s', errorID || 'N/A', errorMessage);
                }
                
                // 如果是认证相关错误，清除令牌
                if (errorID === 'InvalidAuthToken' || errorID === 'AuthenticationFailed' || 
                    errorMessage.toLowerCase().includes('auth') || errorMessage.toLowerCase().includes('token')) {
                    logger.warn('认证令牌可能已失效，将在下次连接时重新申请');
                    this.authToken = null;
                    this.isAuthenticated = false;
                }
            } else {
                // 其他消息类型（包括 API 响应）
                // 检查是否是热键或参数响应（可能在注册处理器前到达）
                if (message.messageType === 'HotkeysInCurrentModelResponse' || 
                    message.messageType === 'InputParameterListResponse') {
                    // 尝试匹配所有待处理的响应（requestID 可能不匹配）
                    if (message.requestID) {
                        const handler = this.pendingResponses.get(message.requestID);
                        if (handler) {
                            handler(message);
                            this.pendingResponses.delete(message.requestID);
                            return;
                        }
                    }
                }
            }
        } catch (err: any) {
            // 静默处理解析错误（除非是严重错误）
        }
    }

    /**
     * 发送消息到 VTube Studio
     */
    private send(message: any): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            logger.warn('VTube Studio 未连接，无法发送消息');
            return;
        }

        try {
            this.ws.send(JSON.stringify(message));
        } catch (err: any) {
            logger.error('发送消息失败: %s', err.message);
        }
    }

    private cachedHotkeys: Array<{ id: string; name: string }> | null = null;
    private hotkeysLoadTime: number = 0;
    private readonly HOTKEYS_CACHE_TTL = 60000; // 缓存60秒

    /**
     * 获取并缓存热键列表
     */
    private async loadHotkeys(): Promise<void> {
        const now = Date.now();
        // 如果缓存过期或不存在，重新加载
        if (!this.cachedHotkeys || (now - this.hotkeysLoadTime) > this.HOTKEYS_CACHE_TTL) {
            try {
                this.cachedHotkeys = await this.getHotkeys();
                this.hotkeysLoadTime = now;
            } catch (err: any) {
                this.cachedHotkeys = [];
            }
        }
    }

    /**
     * 获取热键ID（通过名称智能匹配）
     */
    private async findHotkeyId(actionName: string): Promise<string | null> {
        try {
            // 确保热键列表已加载
            await this.loadHotkeys();
            
            if (!this.cachedHotkeys || this.cachedHotkeys.length === 0) {
                logger.debug('热键列表为空，无法匹配动作: %s', actionName);
                return null;
            }
            
            const actionLower = actionName.toLowerCase();
            
            // 中英文关键词映射（用于匹配中文热键名称）
            const chineseKeywordMap: { [key: string]: string[] } = {
                'happy_nod': ['开心', '点头', '高兴'],
                'confused': ['疑惑', '困惑', '疑问'],
                'shake_head_around': ['摇头', '晃脑'],
                'shy': ['害羞', '羞涩', '平静', '平静+害羞'],
                'idle_tilt_head': ['发呆', '歪头', '呆滞', '出神', '思考', '沉思', '想', '小脑袋', '脑袋'],
                'excited_dance': ['手舞足蹈', '跳舞', '兴奋', '开心'],
                'surprised_blink': ['眨眼', '惊讶', '吃惊'],
                'excited_wave': ['挥手', '招手', '兴奋'],
                'surprised': ['吃惊', '惊讶', '震惊'],
                'sad': ['难过', '悲伤', '伤心'],
            };
            
            // 获取当前动作对应的中文关键词
            const chineseKeywords = chineseKeywordMap[actionName] || [];
            
            // 匹配优先级：精确匹配 > 部分匹配 > 中文匹配 > 规范化匹配
            let bestMatch: string | null = null;
            let bestScore = 0;
            let bestMatchName: string | null = null;
            
            // 仅在首次匹配失败时输出详细日志，避免刷屏
            const isFirstAttempt = !this.currentAnimationMatched;
            
            if (isFirstAttempt) {
                logger.debug('开始匹配动作: %s，可用热键数量: %d', actionName, this.cachedHotkeys.length);
            }
            
            for (const hotkey of this.cachedHotkeys) {
                const hotkeyNameLower = hotkey.name.toLowerCase();
                const hotkeyNameOriginal = hotkey.name; // 保留原始大小写用于中文匹配
                const hotkeyIdLower = hotkey.id.toLowerCase();
                
                // 1. 精确匹配（最高优先级）
                if (hotkeyNameLower === actionLower || hotkeyIdLower === actionLower ||
                    hotkeyNameLower === `action_${actionLower}` || hotkeyIdLower === `action_${actionLower}`) {
                    if (isFirstAttempt) {
                        logger.debug('精确匹配成功: %s → %s', actionName, hotkey.name);
                    }
                    return hotkey.id; // 立即返回精确匹配
                }
                
                let matchScore = 0;
                
                // 2. 部分匹配（检查是否包含英文关键词）
                const actionKeywords = actionLower.split(/[_\s-]+/).filter(k => k.length > 2);
                for (const keyword of actionKeywords) {
                    if (hotkeyNameLower.includes(keyword) || keyword.includes(hotkeyNameLower)) {
                        matchScore += 10;
                    }
                }
                
                // 3. 中文关键词匹配（检查热键名称是否包含对应的中文关键词）
                for (const keyword of chineseKeywords) {
                    if (hotkeyNameOriginal.includes(keyword)) {
                        matchScore += 15; // 中文匹配优先级更高
                        break; // 找到一个匹配即可
                    }
                }
                
                // 4. 规范化匹配（移除特殊字符后比较）
                const normalizedAction = actionLower.replace(/[_\s-]/g, '');
                const normalizedHotkey = hotkeyNameLower.replace(/[_\s-+]/g, '');
                if (normalizedHotkey.includes(normalizedAction) || normalizedAction.includes(normalizedHotkey)) {
                    matchScore += 5;
                }
                
                // 5. 记录最佳匹配
                if (matchScore > bestScore) {
                    bestScore = matchScore;
                    bestMatch = hotkey.id;
                    bestMatchName = hotkey.name;
                }
            }
            
            if (bestMatch && bestScore > 0) {
                if (isFirstAttempt) {
                    logger.debug('找到最佳匹配: %s → %s (得分: %d)', actionName, bestMatchName, bestScore);
                }
                return bestMatch;
            }
            
            // 如果匹配失败，仅在首次尝试时输出所有可用的热键名称用于调试
            if (isFirstAttempt) {
                logger.debug('匹配失败: %s，可用热键: %s', actionName, 
                    this.cachedHotkeys.map(h => h.name).join(', '));
            }
            
            return null;
        } catch (err: any) {
            logger.debug('匹配过程出错: %s', err.message);
            return null;
        }
    }

    /**
     * 触发热键
     */
    async triggerHotkey(hotkeyId: string, originalActionName?: string, silent: boolean = false): Promise<void> {
        if (!this.isAuthenticated) {
            logger.warn('未认证，无法触发热键');
            return;
        }

        // 记录原始动作名称（用于显示）
        const displayActionName = originalActionName || hotkeyId;

        // 如果 hotkeyId 是动作名称而不是ID，尝试查找匹配的热键ID
        let actualHotkeyId = hotkeyId;
        let matchedHotkeyName: string | null = null;
        let isMatched = false;
        
        if (!hotkeyId.includes('-') || hotkeyId.length < 32) {
            // 看起来像是名称而不是UUID格式的ID，尝试查找
            const foundId = await this.findHotkeyId(hotkeyId);
            if (foundId) {
                actualHotkeyId = foundId;
                isMatched = true;
                // 查找热键名称用于显示
                if (this.cachedHotkeys) {
                    const matched = this.cachedHotkeys.find(h => h.id === foundId);
                    if (matched) {
                        matchedHotkeyName = matched.name;
                    }
                }
            }
        } else {
            // 如果是ID，尝试查找名称
            if (this.cachedHotkeys) {
                const matched = this.cachedHotkeys.find(h => h.id === actualHotkeyId);
                if (matched) {
                    matchedHotkeyName = matched.name;
                }
            }
        }

        const request = {
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '1.0',
            requestID: 'hotkey-' + Date.now(),
            messageType: 'HotkeyTriggerRequest',
            data: {
                hotkeyID: actualHotkeyId,
            },
        };

        this.send(request);
        
        // 显示详细的动画触发信息：匹配的热键名称 → 热键ID
        // 如果 silent=true，只在成功匹配时显示，失败时静默
        if (!silent) {
            // 首次触发或非静默模式：显示详细信息
            if (isMatched && matchedHotkeyName) {
                logger.info('  ✓ 系统匹配到热键「%s」→ 调用热键ID: %s', 
                    matchedHotkeyName, actualHotkeyId.substring(0, 8) + '...');
            } else if (matchedHotkeyName) {
                logger.info('  ✓ 热键「%s」已调用', matchedHotkeyName);
            } else {
                logger.warn('  ⚠ 未找到匹配的热键，尝试直接使用动作名: %s (热键ID: %s)', 
                    displayActionName, actualHotkeyId.substring(0, 8) + '...');
            }
        } else {
            // 静默模式：只在首次成功匹配时显示一次
            if (isMatched && matchedHotkeyName && !this.currentAnimationMatched) {
                logger.info('  ✓ 系统匹配到热键「%s」，开始持续触发', matchedHotkeyName);
                this.currentAnimationMatched = true;
            }
            // 失败时不显示警告，避免刷屏
        }
    }

    /**
     * 创建自定义输入参数（注意：VTube Studio API 不支持此功能）
     * 此方法已禁用，参数需要在 VTube Studio 客户端中手动创建
     */
    async createInputParameter(parameterName: string, explanation?: string, min?: number, max?: number, defaultValue?: number): Promise<boolean> {
        // VTube Studio API 不支持通过 API 创建输入参数
        // 返回 false 表示无法创建
        logger.debug('注意：VTube Studio API 不支持通过 API 创建参数，参数 %s 需要在客户端中手动创建', parameterName);
        return false;
    }

    /**
     * 设置参数值
     */
    setParameter(parameterName: string, value: number, weight?: number): void {
        if (!this.isAuthenticated) {
            logger.warn('未认证，无法设置参数');
            return;
        }

        const request = {
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '1.0',
            requestID: 'param-' + Date.now(),
            messageType: 'InjectParameterDataRequest',
            data: {
                parameterValues: [
                    {
                        id: parameterName,
                        value: value,
                        weight: weight !== undefined ? weight : 1.0,
                    },
                ],
            },
        };

        this.send(request);
    }

    /**
     * 处理音频分片，分析音量并同步到 VTube Studio
     */
    processAudioChunk(audioBase64: string, config?: {
        parameterName?: string;
        minVolume?: number;
        maxVolume?: number;
    }): void {
        if (!this.isAuthenticated) {
            return;
        }

        try {
            // 解码 base64 音频
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            
            // 计算音频音量（RMS）
            const volume = this.calculateAudioVolume(audioBuffer);
            
            // 根据配置的参数名称设置
            const paramName = config?.parameterName || 'VoiceVolume';
            const minVol = config?.minVolume ?? 0.0;
            const maxVol = config?.maxVolume ?? 1.0;
            
            // 将音量映射到 0-1 范围
            const normalizedVolume = Math.max(minVol, Math.min(maxVol, volume));
            
            // 设置参数（使用较低的日志级别，避免刷屏）
            this.setParameter(paramName, normalizedVolume);
            
        } catch (err: any) {
        }
    }

    /**
     * 计算音频音量（RMS - Root Mean Square）
     */
    private calculateAudioVolume(audioBuffer: Buffer): number {
        if (audioBuffer.length === 0) {
            return 0;
        }

        // 假设音频格式为 PCM，16-bit 单声道，22050Hz（常见 TTS 格式）
        // 如果不是这个格式，可能需要先转换
        
        let sumSquares = 0;
        const sampleCount = Math.floor(audioBuffer.length / 2); // 16-bit = 2 bytes per sample
        
        for (let i = 0; i < sampleCount; i++) {
            // 读取 16-bit 小端序样本
            const sample = audioBuffer.readInt16LE(i * 2);
            // 归一化到 -1.0 到 1.0
            const normalized = sample / 32768.0;
            sumSquares += normalized * normalized;
        }
        
        if (sampleCount === 0) {
            return 0;
        }
        
        // 计算 RMS
        const rms = Math.sqrt(sumSquares / sampleCount);
        
        // 转换为 0-1 范围的音量值（可以调整敏感度）
        // 使用对数缩放使音量更敏感
        const volume = Math.min(1.0, rms * 2.0); // 简单的线性缩放，可以改为对数
        
        return volume;
    }

    /**
     * 获取所有热键列表
     */
    async getHotkeys(): Promise<Array<{ id: string; name: string; description?: string }>> {
        if (!this.isAuthenticated) {
            logger.warn('未认证，无法获取热键列表');
            return [];
        }

        return new Promise((resolve, reject) => {
            const requestId = 'get-hotkeys-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            
            const timeout = setTimeout(() => {
                this.pendingResponses.delete(requestId);
                reject(new Error('获取热键列表超时'));
            }, 10000);

            // 先注册响应处理器（在发送请求之前）
            this.pendingResponses.set(requestId, (message: any) => {
                clearTimeout(timeout);
                
                if (message.messageType === 'HotkeysInCurrentModelResponse') {
                    const hotkeys = message.data?.availableHotkeys || [];
                    resolve(hotkeys.map((h: any) => ({
                        id: h.hotkeyID,
                        name: h.name,
                        description: h.file,
                    })));
                } else if (message.messageType === 'APIError') {
                    reject(new Error(message.data?.message || '获取热键列表失败'));
                }
            });

            // 然后发送请求
            const request = {
                apiName: 'VTubeStudioPublicAPI',
                apiVersion: '1.0',
                requestID: requestId,
                messageType: 'HotkeysInCurrentModelRequest',
            };
            
            this.send(request);
        });
    }

    /**
     * 获取所有输入参数列表
     */
    async getInputParameters(): Promise<Array<{ id: string; name: string; defaultValue: number; min: number; max: number }>> {
        if (!this.isAuthenticated) {
            logger.warn('未认证，无法获取参数列表');
            return [];
        }

        return new Promise((resolve, reject) => {
            const requestId = 'get-params-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            
            const timeout = setTimeout(() => {
                this.pendingResponses.delete(requestId);
                reject(new Error('获取参数列表超时'));
            }, 10000);

            // 先注册响应处理器（在发送请求之前）
            this.pendingResponses.set(requestId, (message: any) => {
                clearTimeout(timeout);
                
                if (message.messageType === 'InputParameterListResponse') {
                    const params = message.data?.defaultParameters || [];
                    resolve(params.map((p: any) => ({
                        id: p.name,
                        name: p.name,
                        defaultValue: p.defaultValue || 0,
                        min: p.min || 0,
                        max: p.max || 1,
                    })));
                } else if (message.messageType === 'APIError') {
                    reject(new Error(message.data?.message || '获取参数列表失败'));
                }
            });

            // 然后发送请求
            const request = {
                apiName: 'VTubeStudioPublicAPI',
                apiVersion: '1.0',
                requestID: requestId,
                messageType: 'InputParameterListRequest',
            };
            
            this.send(request);
        });
    }

    /**
     * 检查并报告 VTube Studio 配置状态
     */
    async checkConfiguration(): Promise<{
        hotkeys: { optional: string[]; missing: string[]; available: string[]; availableNames?: string[] };
        parameters: { 
            essential: string[]; 
            optional: string[]; 
            missingEssential: string[]; 
            missingOptional: string[]; 
            available: string[] 
        };
    }> {
        if (!this.isAuthenticated) {
            logger.warn('未认证，无法检查配置');
            return {
                hotkeys: { optional: [], missing: [], available: [] },
                parameters: { 
                    essential: [], 
                    optional: [], 
                    missingEssential: [], 
                    missingOptional: [], 
                    available: [] 
                },
            };
        }

        // 可选的热键（用于 AI 控制动作）- 这些是建议的，不是强制的
        // 注意：根据用户模型，优先匹配组合动作（表情+动作）
        const optionalHotkeys = [
            // 用户模型的10个动画（优先级最高）
            'happy_nod', 'happy_nod_1', '开心点头', '开心+点头',
            'confused', '疑惑',
            'shake_head_around', '摇头晃脑', '摇头',
            'shy', '平静害羞', '害羞', '平静+害羞',
            'idle_tilt_head', 'idle', '发呆', '歪头', '发呆+歪头', '发呆歪头', '呆滞', '出神', '思考', '沉思', '想', '小脑袋', '脑袋',
            'excited_dance', 'dance', '手舞足蹈', '开心手舞足蹈', '开心+手舞足蹈',
            'surprised_blink', 'blink', '眨眼', '惊讶眨眼', '惊讶+眨眼',
            'excited_wave', 'wave', '挥手', '兴奋挥手', '兴奋+挥手',
            'surprised', '吃惊', '惊讶',
            'sad', '难过', '悲伤',
            // 通用动作（作为备选）
            'action_wave', 'action_nod', 'action_shake_head', 'action_clap',
            'action_point', 'action_bow', 'action_think', 'action_thumbs_up',
            'action_heart', 'action_stretch', 'action_turn', 'action_dance',
            'action_sit', 'action_stand', 'action_jump', 'action_shrug',
        ];

        // 必需的参数（用于 AI 控制表情和状态）
        const essentialParameters = ['VoiceVolume']; // VoiceVolume 是必需的（用于音频同步）
        
        // 可选的表情参数
        const optionalParameters = [
            'Expression_happy',
            'Expression_sad',
            'Expression_angry',
            'Expression_surprised',
            'Expression_excited',
            'Expression_neutral',
            'Speaking',
        ];

        try {
            // 获取当前热键和参数
            const [availableHotkeys, availableParameters] = await Promise.all([
                this.getHotkeys(),
                this.getInputParameters(),
            ]);

            const hotkeyIds = availableHotkeys.map(h => h.id);
            const hotkeyNames = availableHotkeys.map(h => h.name);
            const paramIds = availableParameters.map(p => p.id);

            // 检查缺失的配置（更宽松的匹配）
            const missingHotkeys = optionalHotkeys.filter(req => {
                // 检查是否有匹配的热键（支持部分匹配和不同命名格式）
                const matched = hotkeyIds.some(available => {
                    const reqLower = req.toLowerCase();
                    const availableLower = available.toLowerCase();
                    // 精确匹配或包含匹配
                    return availableLower === reqLower || 
                           availableLower.includes(reqLower) || 
                           reqLower.includes(availableLower) ||
                           availableLower.replace(/[_-]/g, '') === reqLower.replace(/[_-]/g, '');
                });
                return !matched;
            });

            // 检查必需参数
            const missingEssentialParams = essentialParameters.filter(
                req => !paramIds.includes(req)
            );
            
            // 检查可选参数
            const missingOptionalParams = optionalParameters.filter(
                req => !paramIds.includes(req)
            );

            return {
                hotkeys: {
                    optional: optionalHotkeys,
                    missing: missingHotkeys,
                    available: hotkeyIds,
                    availableNames: hotkeyNames, // 添加热键名称列表
                },
                parameters: {
                    essential: essentialParameters,
                    optional: optionalParameters,
                    missingEssential: missingEssentialParams,
                    missingOptional: missingOptionalParams,
                    available: paramIds,
                },
            };
        } catch (err: any) {
            logger.error('检查 VTube Studio 配置失败: %s', err.message);
            return {
                hotkeys: { optional: optionalHotkeys, missing: optionalHotkeys, available: [], availableNames: [] },
                parameters: { 
                    essential: essentialParameters, 
                    optional: optionalParameters,
                    missingEssential: essentialParameters,
                    missingOptional: optionalParameters,
                    available: [] 
                },
            };
        }
    }

    /**
     * 打印配置检查报告
     */
    printConfigurationReport(config: {
        hotkeys: { optional: string[]; missing: string[]; available: string[]; availableNames?: string[] };
        parameters: { 
            essential: string[]; 
            optional: string[]; 
            missingEssential: string[]; 
            missingOptional: string[]; 
            available: string[] 
        };
    }): void {
        logger.info('=== VTube Studio 配置检查 ===');
        
        // 热键配置（全部为可选的）
        logger.info('热键配置（可选）:');
        logger.info('  - 可用: %d 个', config.hotkeys.available.length);
        if (config.hotkeys.available.length > 0) {
            logger.info('  现有热键:');
            config.hotkeys.available.forEach((id, idx) => {
                const name = config.hotkeys.availableNames?.[idx] || '未知名称';
                logger.info('    %d. %s (ID: %s)', idx + 1, name, id);
            });
        }
        if (config.hotkeys.missing.length > 0) {
            logger.info('  - 建议创建: %d 个', config.hotkeys.missing.length);
            logger.info('  示例: %s...', config.hotkeys.missing.slice(0, 3).join(', '));
            logger.info('  提示: 这些热键用于 AI 控制动作，可以在 VTube Studio 中按需创建');
        } else {
            logger.info('  ✓ 所有建议的热键都已配置');
        }

        // 参数状态
        logger.info('参数配置:');
        logger.info('  - 可用: %d 个', config.parameters.available.length);
        
        // 必需参数检查
        if (config.parameters.missingEssential.length > 0) {
            logger.error('  - 缺失必需参数: %d 个', config.parameters.missingEssential.length);
            logger.error('  缺失: %s', config.parameters.missingEssential.join(', '));
            logger.error('  ⚠️  这些参数是必需的，请务必在 VTube Studio 中创建（类型：数值，范围：0-1）');
        } else {
            logger.info('  ✓ 所有必需参数已配置: %s', config.parameters.essential.join(', '));
        }
        
        // 可选参数检查
        if (config.parameters.missingOptional.length > 0) {
            logger.info('  - 可选参数未配置: %d 个', config.parameters.missingOptional.length);
            logger.info('  未配置: %s', config.parameters.missingOptional.join(', '));
            logger.info('  提示: 这些参数用于 AI 控制表情，可以在 VTube Studio 中按需创建（类型：数值，范围：0-1）');
        } else {
            logger.info('  ✓ 所有可选参数已配置');
        }
        
        // 总结
        const hasIssues = config.parameters.missingEssential.length > 0;
        if (hasIssues) {
            logger.error('❌ 配置检查发现问题，请修复必需参数的缺失');
        } else if (config.hotkeys.missing.length > 0 || config.parameters.missingOptional.length > 0) {
            logger.info('ℹ️  基础配置完整，可选功能可按需配置');
        } else {
            logger.info('✓ 配置检查通过，所有建议的配置项都已就绪');
        }

    }

    /**
     * 开始持续触发动画序列（用于流式播放期间）
     */
    startContinuousAnimation(animations: Array<{ name: string; duration: number }>): void {
        if (!this.isAuthenticated || !animations || animations.length === 0) {
            return;
        }

        // 停止之前的动画（如果有）
        this.stopContinuousAnimation();

        // 显示随机选择的动画序列
        const animationNames = animations.map(a => a.name).join(', ');
        logger.info('🎬 开始循环播放动画序列: %s（将循环直到语音结束）', animationNames);
        
        // 保存动画序列
        this.currentAnimationQueue = animations;
        this.currentAnimationIndex = 0;
        this.currentAnimationMatched = false;

        // 立即触发第一个动画
        this.triggerNextAnimation();
    }

    /**
     * 触发下一个动画（内部方法，循环播放动画序列直到停止）
     */
    private triggerNextAnimation(): void {
        if (!this.isAuthenticated || !this.currentAnimationQueue || this.currentAnimationQueue.length === 0) {
            return;
        }

        // 获取当前动画
        const currentAnimation = this.currentAnimationQueue[this.currentAnimationIndex];
        if (!currentAnimation) {
            // 如果索引超出，重置到开头（循环播放）
            this.currentAnimationIndex = 0;
            const firstAnimation = this.currentAnimationQueue[0];
            if (!firstAnimation) {
                return;
            }
            const animationName = firstAnimation.name;
            const duration = firstAnimation.duration || 3000;
            
            // 直接使用名称查找热键ID，不进行复杂匹配
            this.triggerHotkeyDirect(animationName);
            
            // 移动到下一个动画
            this.currentAnimationIndex = 1;
            
            // 设置定时器，继续循环
            this.currentAnimationInterval = setTimeout(() => {
                if (this.isAuthenticated && this.currentAnimationQueue.length > 0) {
                    this.triggerNextAnimation();
                }
            }, duration);
            return;
        }

        const animationName = currentAnimation.name;
        const duration = currentAnimation.duration || 3000; // 默认3秒

        // 直接使用名称查找热键ID并触发，不进行复杂匹配
        this.triggerHotkeyDirect(animationName);

        // 移动到下一个动画
        this.currentAnimationIndex += 1;
        
        // 如果索引超出范围，重置到开头（循环播放）
        if (this.currentAnimationIndex >= this.currentAnimationQueue.length) {
            this.currentAnimationIndex = 0;
        }

        // 等待当前动画完成后触发下一个（循环）
        this.currentAnimationInterval = setTimeout(() => {
            if (this.isAuthenticated && this.currentAnimationQueue.length > 0) {
                this.triggerNextAnimation();
            }
        }, duration);
    }
    
    /**
     * 直接触发热键（使用名称，不进行复杂匹配）
     */
    private async triggerHotkeyDirect(hotkeyName: string): Promise<void> {
        if (!this.isAuthenticated) {
            return;
        }

        // 直接通过名称查找热键ID（简单查找，不进行复杂匹配）
        let hotkeyId: string | null = null;
        
        // 尝试从缓存中找到匹配的热键
        if (this.cachedHotkeys) {
            const matched = this.cachedHotkeys.find(h => h.name === hotkeyName);
            if (matched) {
                hotkeyId = matched.id;
            }
        }
        
        // 如果没找到，尝试获取最新的热键列表（简单查找）
        if (!hotkeyId) {
            try {
                const hotkeys = await this.getHotkeys();
                const matched = hotkeys.find(h => h.name === hotkeyName);
                if (matched) {
                    hotkeyId = matched.id;
                }
            } catch (err: any) {
                logger.debug('获取热键列表失败: %s', err.message);
            }
        }
        
        if (!hotkeyId) {
            logger.warn('未找到热键: %s', hotkeyName);
            return;
        }

        const request = {
            apiName: 'VTubeStudioPublicAPI',
            apiVersion: '1.0',
            requestID: 'hotkey-' + Date.now(),
            messageType: 'HotkeyTriggerRequest',
            data: {
                hotkeyID: hotkeyId,
            },
        };

        this.send(request);
        logger.info('  ✓ 触发热键「%s」', hotkeyName);
    }

    /**
     * 停止持续触发动画
     */
    stopContinuousAnimation(): void {
        if (this.currentAnimationInterval) {
            clearTimeout(this.currentAnimationInterval);
            this.currentAnimationInterval = null;
        }
        if (this.currentAnimationQueue.length > 0) {
            const currentName = this.currentAnimationQueue[this.currentAnimationIndex]?.name || '未知';
            logger.info('⏹ 停止动画序列: %s', this.currentAnimationQueue.map(a => a.name).join(', '));
            this.currentAnimationQueue = [];
            this.currentAnimationIndex = 0;
            this.currentAnimationMatched = false;
        }
    }

    /**
     * 应用 VTuber 控制指令
     */
    applyControl(control: VTuberControl): void {
        if (!this.isAuthenticated) {
            return;
        }

        // 动作控制 -> 触发热键（仅用于非流式播放）
        if (control.type === 'action' && control.action) {
            // 智能热键映射：尝试找到匹配的热键
            const actionName = control.action.name;
            
            // 先显示AI想要触发的动作（在匹配之前）
            logger.info('🎯 AI 想要触发动作: %s', actionName);
            
            // 异步触发热键（会尝试匹配现有热键，传递原始动作名用于显示）
            this.triggerHotkey(actionName, actionName).catch(err => {
                logger.warn('触发动作失败: %s - %s', actionName, err.message);
            });
        }

        // 表情控制已移除：因为用户模型的动画已经包含表情+动作的组合，不需要单独控制表情

        // 说话状态控制 -> 设置嘴型同步参数
        if (control.type === 'speaking' && control.speaking) {
            const isSpeaking = control.speaking.isSpeaking;
            // 设置说话参数
            this.setParameter('Speaking', isSpeaking ? 1.0 : 0.0);
            if (isSpeaking && control.speaking.volume !== undefined) {
                // 可以设置音量参数用于嘴型同步
                this.setParameter('VoiceVolume', control.speaking.volume);
            }
        }

        // 重置控制
        if (control.type === 'reset' && control.reset) {
            if (control.reset.action) {
                // 触发重置动作热键
                this.triggerHotkey('action_reset').catch(() => {
                    // 忽略错误
                });
            }
            if (control.reset.expression) {
                // 重置所有表情参数
                const emotions = ['happy', 'sad', 'angry', 'surprised', 'excited', 'neutral'];
                emotions.forEach(emotion => {
                    this.setParameter(`Expression_${emotion}`, 0.0);
                });
            }
        }
    }

    /**
     * 尝试重连
     */
    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.warn('已达到最大重连次数 (%d)，停止自动重连', this.maxReconnectAttempts);
            logger.info('提示：请启动 VTube Studio 后重新启动客户端，或在配置中禁用 VTuber 功能');
            return;
        }

        if (this.reconnectTimer) {
            return; // 已有重连计划
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * this.reconnectAttempts;
        
        // 只在第一次和每5次重连时显示详细信息
        if (this.reconnectAttempts === 1 || this.reconnectAttempts % 5 === 0) {
            logger.info('将在 %d 秒后尝试重连 VTube Studio (尝试 %d/%d)', delay / 1000, this.reconnectAttempts, this.maxReconnectAttempts);
        } else {
            logger.debug('将在 %d 秒后尝试重连 (尝试 %d/%d)', delay / 1000, this.reconnectAttempts, this.maxReconnectAttempts);
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    /**
     * 断开连接（停止自动重连）
     */
    disconnect(): void {
        // 停止持续触发动画
        this.stopContinuousAnimation();
        
        // 停止重连定时器
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            // 移除所有事件监听器，避免触发重连
            this.ws.removeAllListeners();
            // 正常关闭连接（code 1000）
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close(1000, 'Manual disconnect');
            }
            this.ws = null;
        }

        this.isAuthenticated = false;
        this.reconnectAttempts = 0; // 重置重连计数
        logger.info('已断开 VTube Studio 连接');
    }

    /**
     * 检查是否已连接并认证
     */
    isConnected(): boolean {
        return this.isAuthenticated && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * 自动创建缺失的参数（已禁用：VTube Studio API 不支持此功能）
     */
    async autoCreateMissingParameters(): Promise<void> {
        // VTube Studio API 不支持通过 API 创建输入参数
        // 参数需要在 VTube Studio 客户端中手动创建
        // 此功能已禁用
        return;
    }

    /**
     * 检查并报告配置（异步，不阻塞）
     */
    private async checkAndReportConfiguration(): Promise<void> {
        // 延迟一下，确保认证完成且连接稳定
        setTimeout(async () => {
            // 再次确认已认证
            if (!this.isAuthenticated) {
                logger.debug('未认证，跳过配置检查');
                return;
            }
            
            try {
                const config = await this.checkConfiguration();
                this.printConfigurationReport(config);
                
                // 注意：VTube Studio API 不支持通过 API 创建输入参数或热键
                // 参数和热键需要在 VTube Studio 客户端中手动创建
                // 已禁用自动创建功能
            } catch (err: any) {
                logger.debug('检查配置时出错: %s', err.message);
            }
        }, 2000); // 延迟 2 秒，确保认证完全完成后再检查配置
    }

    /**
     * 获取认证令牌（用于保存配置）
     */
    getAuthToken(): string | null {
        return this.authToken;
    }

    /**
     * 从数据库读取认证令牌
     */
    private async loadAuthTokenFromDB(): Promise<string | null> {
        try {
            const { getGlobalWsConnection } = require('./client');
            const ws = getGlobalWsConnection();
            
            if (!ws || ws.readyState !== 1) {
                logger.debug('WebSocket 未连接，无法从数据库读取认证令牌');
                return null;
            }
            
            return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    ws.removeListener('message', handler);
                    logger.debug('读取认证令牌超时（5秒内未收到响应）');
                    resolve(null);
                }, 5000);
                
                const handler = (data: any) => {
                    try {
                        let msg: any;
                        if (typeof data === 'string') {
                            msg = JSON.parse(data);
                        } else if (Buffer.isBuffer(data)) {
                            msg = JSON.parse(data.toString('utf8'));
                        } else {
                            msg = data;
                        }
                        
                        if (msg && msg.key === 'vtuber_auth_token_get') {
                            clearTimeout(timeout);
                            ws.removeListener('message', handler);
                            
                            if (msg.error) {
                                logger.warn('读取认证令牌失败: %s', msg.error);
                                resolve(null);
                            } else if (msg.authToken) {
                                logger.info('✓ 从数据库读取到认证令牌');
                                resolve(msg.authToken);
                            } else {
                                logger.debug('数据库中未找到认证令牌');
                                resolve(null);
                            }
                        }
                    } catch (err: any) {
                        // 忽略解析错误，继续等待正确的响应
                        logger.debug('解析消息失败（等待认证令牌响应）: %s', err.message);
                    }
                };
                
                // 先注册监听器，再发送请求
                ws.on('message', handler);
                
                // 发送请求
                const request = {
                    key: 'vtuber_auth_token_get',
                    host: this.host,
                    port: this.port,
                };
                
                logger.debug('发送读取认证令牌请求: %s', JSON.stringify(request));
                ws.send(JSON.stringify(request));
            });
        } catch (err: any) {
            logger.debug('从数据库读取认证令牌失败: %s', err.message);
            return null;
        }
    }
    
    /**
     * 保存认证令牌到数据库
     */
    private saveAuthToken(): void {
        try {
            const { getGlobalWsConnection } = require('./client');
            const ws = getGlobalWsConnection();
            
            if (!ws || ws.readyState !== 1) {
                logger.warn('WebSocket 未连接，无法保存认证令牌到数据库');
                return;
            }
            
            const message = {
                key: 'vtuber_auth_token_save',
                host: this.host,
                port: this.port,
                authToken: this.authToken || '',
            };
            
            ws.send(JSON.stringify(message));
            
            if (this.authToken) {
                logger.info('✓ 认证令牌已保存到数据库，下次启动将自动使用');
            } else {
                logger.debug('已清除数据库中的认证令牌');
            }
        } catch (err: any) {
            logger.error('保存认证令牌失败: %s', err.message);
        }
    }
}

// 单例实例
let vtsClient: VTubeStudioClient | null = null;

/**
 * 初始化 VTube Studio 客户端
 */
export function initVTubeStudioClient(config?: {
    host?: string;
    port?: number;
    apiName?: string;
    apiVersion?: string;
    authToken?: string;
}): VTubeStudioClient {
    if (!vtsClient) {
        vtsClient = new VTubeStudioClient(config);
        vtsClient.connect();
    }
    return vtsClient;
}

/**
 * 获取 VTube Studio 客户端实例
 */
export function getVTubeStudioClient(): VTubeStudioClient | null {
    return vtsClient;
}

/**
 * 等待 VTube Studio 认证完成
 */
export async function waitForVTubeStudioAuthentication(timeout: number = 10000): Promise<boolean> {
    const client = getVTubeStudioClient();
    if (!client) {
        return false;
    }

    // 如果已经认证，直接返回
    if (client.isConnected()) {
        return true;
    }

    // 等待认证 Promise
    const authPromise = (client as any).authenticationPromise;
    if (authPromise) {
        try {
            return await Promise.race([
                authPromise,
                new Promise<boolean>((_, reject) => 
                    setTimeout(() => reject(new Error('认证超时')), timeout)
                ),
            ]);
        } catch (err: any) {
            logger.warn('等待 VTube Studio 认证失败: %s', err.message);
            return false;
        }
    }

    // 如果没有认证 Promise，等待一段时间后检查状态
    return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = timeout / 100;
        const checkInterval = setInterval(() => {
            if (client.isConnected()) {
                clearInterval(checkInterval);
                resolve(true);
            } else if (++attempts >= maxAttempts) {
                clearInterval(checkInterval);
                resolve(false);
            }
        }, 100);
    });
}

