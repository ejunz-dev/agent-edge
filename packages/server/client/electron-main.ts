// @ts-ignore - Electron 类型定义在运行时可用
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';

// 延迟导入以避免循环依赖
let getVoiceClient: (() => any) | null = null;

let mainWindow: BrowserWindow | null = null;
let voiceClient: any = null;

function createWindow() {
    // 确保预加载脚本和 HTML 文件的路径正确
    const preloadPath = path.join(__dirname, 'electron-preload.js');
    const htmlPath = path.join(__dirname, 'electron-ui.html');
    
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false, // 开发模式允许加载本地文件
        },
        title: 'Agent Edge Voice Client',
        icon: undefined, // 可以添加图标路径
    });

    // 加载界面
    mainWindow.loadFile(htmlPath);

    // 开发模式下打开开发者工具
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 延迟加载 getVoiceClient
function loadVoiceClient() {
    if (!getVoiceClient) {
        try {
            const clientModule = require('./client');
            getVoiceClient = clientModule.getVoiceClient;
        } catch (e) {
            console.error('无法加载语音客户端模块:', e);
        }
    }
}

// IPC 处理：获取语音客户端状态
ipcMain.handle('get-voice-client-status', () => {
    loadVoiceClient();
    if (!getVoiceClient) {
        return { available: false, recording: false };
    }
    voiceClient = getVoiceClient();
    return {
        available: voiceClient !== null,
        recording: voiceClient ? (voiceClient as any).isRecording || false : false,
    };
});

// IPC 处理：开始录音
ipcMain.handle('start-recording', async () => {
    try {
        loadVoiceClient();
        if (!getVoiceClient) {
            throw new Error('语音客户端模块未加载');
        }
        voiceClient = getVoiceClient();
        if (!voiceClient) {
            throw new Error('语音客户端未初始化');
        }
        await voiceClient.startRecording();
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

// IPC 处理：停止录音并发送
ipcMain.handle('stop-recording-and-send', async () => {
    try {
        loadVoiceClient();
        if (!getVoiceClient) {
            throw new Error('语音客户端模块未加载');
        }
        voiceClient = getVoiceClient();
        if (!voiceClient) {
            throw new Error('语音客户端未初始化');
        }
        await voiceClient.stopRecordingAndSend();
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

// IPC 处理：发送文本消息
ipcMain.handle('send-text-message', async (_, text: string) => {
    try {
        loadVoiceClient();
        if (!getVoiceClient) {
            throw new Error('语音客户端模块未加载');
        }
        voiceClient = getVoiceClient();
        if (!voiceClient) {
            throw new Error('语音客户端未初始化');
        }
        
        const ws = (voiceClient as any).ws;
        if (!ws || ws.readyState !== 1) {
            throw new Error('WebSocket 未连接');
        }

        const message = {
            key: 'voice_chat',
            text: text,
            format: 'text',
            conversationHistory: voiceClient.getConversationHistory().slice(-10),
        };

        ws.send(JSON.stringify(message));
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
});

// IPC 处理：获取对话历史
ipcMain.handle('get-conversation-history', () => {
    loadVoiceClient();
    if (!getVoiceClient) {
        return [];
    }
    voiceClient = getVoiceClient();
    if (!voiceClient) {
        return [];
    }
    return voiceClient.getConversationHistory();
});

// IPC 处理：重置对话历史
ipcMain.handle('reset-conversation', () => {
    loadVoiceClient();
    if (!getVoiceClient) {
        return { success: false, error: '语音客户端模块未加载' };
    }
    voiceClient = getVoiceClient();
    if (voiceClient) {
        voiceClient.resetConversation();
    }
    return { success: true };
});

// 监听语音客户端事件并转发到渲染进程
let eventHandlersAttached = false;
function setupVoiceClientEvents() {
    // 定期检查语音客户端状态并附加事件监听
    const checkInterval = setInterval(() => {
        loadVoiceClient();
        if (!getVoiceClient) {
            return;
        }
        voiceClient = getVoiceClient();
        if (voiceClient && mainWindow && !eventHandlersAttached) {
            // 监听事件（只附加一次）
            voiceClient.on('recordingStarted', () => {
                mainWindow?.webContents.send('voice-event', { type: 'recordingStarted' });
            });

            voiceClient.on('recordingStopped', () => {
                mainWindow?.webContents.send('voice-event', { type: 'recordingStopped' });
            });

            voiceClient.on('response', (data: any) => {
                mainWindow?.webContents.send('voice-event', { type: 'response', data });
            });

            voiceClient.on('error', (error: Error) => {
                mainWindow?.webContents.send('voice-event', { type: 'error', error: error.message });
            });

            voiceClient.on('transcription', (text: string) => {
                mainWindow?.webContents.send('voice-event', { type: 'transcription', text });
            });
            
            eventHandlersAttached = true;
            clearInterval(checkInterval);
        }
    }, 500);
}

app.whenReady().then(() => {
    createWindow();
    setupVoiceClientEvents();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // 不退出应用，因为后端服务还在运行
    // app.quit();
});

app.on('before-quit', () => {
    if (mainWindow) {
        mainWindow.removeAllListeners('close');
    }
});

