const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
    // 获取语音客户端状态
    getVoiceClientStatus: () => ipcRenderer.invoke('get-voice-client-status'),
    
    // 开始录音
    startRecording: () => ipcRenderer.invoke('start-recording'),
    
    // 停止录音并发送
    stopRecordingAndSend: () => ipcRenderer.invoke('stop-recording-and-send'),
    
    // 发送文本消息
    sendTextMessage: (text) => ipcRenderer.invoke('send-text-message', text),
    
    // 获取对话历史
    getConversationHistory: () => ipcRenderer.invoke('get-conversation-history'),
    
    // 重置对话历史
    resetConversation: () => ipcRenderer.invoke('reset-conversation'),
    
    // 监听语音事件
    onVoiceEvent: (callback) => {
        ipcRenderer.on('voice-event', (_, data) => callback(data));
    },
    
    // 移除事件监听
    removeVoiceEventListeners: () => {
        ipcRenderer.removeAllListeners('voice-event');
    },
});

