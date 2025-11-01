import { Logger } from '@ejunz/utils';
import * as dgram from 'dgram';
import { VTuberControl } from './vtuber-server';

const logger = new Logger('vtuber-osc');

/**
 * OSC 协议桥接器 - 用于连接桌面 VTuber 应用（如 VSeeFace）
 * VSeeFace 支持通过 OSC 协议接收控制指令
 * 
 * OSC 地址格式：
 * - /avatar/parameters/{参数名} (VRChat Avatar Parameters)
 * - /vtuber/action/{动作名}
 * - /vtuber/expression/{表情名}
 * - /vtuber/speaking (bool)
 */
export class VTuberOSCBridge {
    private client: dgram.Socket | null = null;
    private host: string;
    private port: number;
    private enabled: boolean;

    constructor(host = '127.0.0.1', port = 9000, enabled = false) {
        this.host = host;
        this.port = port;
        this.enabled = enabled;
        
        if (enabled) {
            this.init();
        }
    }

    private init() {
        try {
            this.client = dgram.createSocket('udp4');
            logger.info('VTuber OSC 桥接器已初始化: %s:%d', this.host, this.port);
        } catch (err: any) {
            logger.error('初始化 OSC 桥接器失败: %s', err.message);
            this.enabled = false;
        }
    }

    /**
     * 发送 OSC 消息
     * OSC 消息格式：地址 + 类型标签 + 参数值
     */
    private sendOSC(address: string, value: number | boolean | string) {
        if (!this.enabled || !this.client) {
            return;
        }

        try {
            // 简化的 OSC 消息格式（完整 OSC 协议需要更多编码）
            // 这里使用文本格式，VSeeFace 可能需要二进制格式
            const message = `${address},${value}`;
            const buffer = Buffer.from(message);
            
            this.client.send(buffer, this.port, this.host, (err) => {
                if (err) {
                    logger.debug('发送 OSC 消息失败: %s', err.message);
                } else {
                    logger.debug('已发送 OSC: %s = %s', address, value);
                }
            });
        } catch (err: any) {
            logger.error('OSC 消息发送错误: %s', err.message);
        }
    }

    /**
     * 处理 VTuber 控制指令并转换为 OSC
     */
    handleControl(control: VTuberControl) {
        if (!this.enabled) {
            return;
        }

        if (control.type === 'action' && control.action) {
            // 发送动作指令
            const actionName = control.action.name;
            this.sendOSC(`/vtuber/action/${actionName}`, 1);
            
            // VRChat 风格的参数（如果使用 VRChat Avatar）
            this.sendOSC(`/avatar/parameters/${actionName}`, 1);
        }

        if (control.type === 'expression' && control.expression) {
            // 发送表情指令
            const emotion = control.expression.emotion;
            this.sendOSC(`/vtuber/expression/${emotion}`, control.expression.intensity || 0.7);
            
            // 重置其他表情
            const emotions = ['happy', 'sad', 'angry', 'surprised', 'excited', 'neutral'];
            emotions.forEach(e => {
                if (e !== emotion) {
                    this.sendOSC(`/vtuber/expression/${e}`, 0);
                }
            });
        }

        if (control.type === 'speaking' && control.speaking) {
            // 发送说话状态
            this.sendOSC('/vtuber/speaking', control.speaking.isSpeaking ? 1 : 0);
            
            // VRChat Viseme（嘴型）参数
            if (control.speaking.isSpeaking) {
                // 可以发送音量/音调用于嘴型同步
                this.sendOSC('/avatar/parameters/Voice', control.speaking.volume || 0.7);
            } else {
                this.sendOSC('/avatar/parameters/Voice', 0);
            }
        }

        if (control.type === 'reset' && control.reset) {
            if (control.reset.action) {
                // 重置所有动作
                const actions = ['wave', 'nod', 'shake_head', 'point', 'clap', 'think', 'bow'];
                actions.forEach(action => {
                    this.sendOSC(`/vtuber/action/${action}`, 0);
                    this.sendOSC(`/avatar/parameters/${action}`, 0);
                });
            }
            if (control.reset.expression) {
                // 重置所有表情
                const emotions = ['happy', 'sad', 'angry', 'surprised', 'excited'];
                emotions.forEach(emotion => {
                    this.sendOSC(`/vtuber/expression/${emotion}`, 0);
                });
                this.sendOSC('/vtuber/expression/neutral', 1);
            }
        }
    }

    /**
     * 关闭 OSC 桥接器
     */
    close() {
        if (this.client) {
            this.client.close();
            this.client = null;
            logger.info('VTuber OSC 桥接器已关闭');
        }
    }
}

// 全局 OSC 桥接器实例（可选）
let globalOSCBridge: VTuberOSCBridge | null = null;

/**
 * 初始化全局 OSC 桥接器
 */
export function initOSCBridge(host?: string, port?: number): void {
    if (globalOSCBridge) {
        logger.debug('OSC 桥接器已存在，跳过初始化');
        return;
    }
    
    globalOSCBridge = new VTuberOSCBridge(host, port, true);
    logger.info('全局 OSC 桥接器已初始化');
}

/**
 * 获取全局 OSC 桥接器
 */
export function getOSCBridge(): VTuberOSCBridge | null {
    return globalOSCBridge;
}

/**
 * 关闭全局 OSC 桥接器
 */
export function closeOSCBridge(): void {
    if (globalOSCBridge) {
        globalOSCBridge.close();
        globalOSCBridge = null;
    }
}

