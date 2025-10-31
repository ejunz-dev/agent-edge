<template>
    <n-card bordered shadow="always" style="max-width: 1200px; margin: 0 auto;">
        <n-scrollbar style="max-height: 90vh;">
            <n-space vertical size="large">
                <!-- 连接状态 -->
                <n-card>
                    <n-space justify="space-between" align="center">
                        <n-statistic label="连接状态">
                            <n-tag :type="connected ? 'success' : 'error'" size="large">
                                {{ connected ? '已连接' : '未连接' }}
                            </n-tag>
                        </n-statistic>
                        <n-button v-if="connected" size="small" @click="clearHistory">清空历史</n-button>
                    </n-space>
                </n-card>

                <!-- 错误提示 -->
                <n-card v-if="error" style="background-color: rgba(208, 48, 80, 0.1);">
                    <n-tag type="error">{{ error }}</n-tag>
                </n-card>

                <!-- 录音控制 -->
                <n-card>
                    <n-space vertical>
                        <n-statistic label="录音状态">
                            <n-tag :type="recording ? 'error' : 'default'" size="large">
                                {{ recording ? '正在录音...' : '未录音' }}
                            </n-tag>
                        </n-statistic>
                        <n-button
                            :type="recording ? 'error' : 'primary'"
                            :loading="processing"
                            :disabled="!connected || processing"
                            size="large"
                            style="width: 100%;"
                            @click="toggleRecording"
                        >
                            <template #icon>
                                <span v-if="recording">🎤</span>
                                <span v-else>⏹️</span>
                            </template>
                            {{ recording ? '停止录音并发送' : '开始录音' }}
                        </n-button>
                    </n-space>
                </n-card>

                <!-- 实时转录 -->
                <n-card v-if="currentTranscript">
                    <n-space vertical>
                        <n-statistic label="实时转录">
                            <div style="font-size: 18px; color: #18a058; margin-top: 8px;">
                                {{ currentTranscript }}
                            </div>
                        </n-statistic>
                    </n-space>
                </n-card>

                <!-- 对话历史 -->
                <n-card>
                    <n-statistic label="对话历史" style="margin-bottom: 16px;" />
                    <n-scrollbar style="max-height: 400px;">
                        <n-space v-if="messages.length === 0" vertical align="center" style="padding: 40px;">
                            <span style="color: rgba(255, 255, 255, 0.5);">暂无对话记录</span>
                        </n-space>
                        <n-space v-else vertical :size="12">
                            <n-card
                                v-for="(msg, idx) in messages"
                                :key="idx"
                                :style="{
                                    backgroundColor: msg.role === 'user' ? 'rgba(24, 160, 88, 0.1)' : 'rgba(32, 128, 240, 0.1)',
                                    marginLeft: msg.role === 'assistant' ? 0 : 'auto',
                                    marginRight: msg.role === 'user' ? 0 : 'auto',
                                    maxWidth: '80%',
                                }"
                            >
                                <n-space vertical :size="4">
                                    <n-tag :type="msg.role === 'user' ? 'success' : 'info'" size="small">
                                        {{ msg.role === 'user' ? '用户' : 'AI助手' }}
                                    </n-tag>
                                    <div style="white-space: pre-wrap;">{{ msg.text }}</div>
                                    <div style="font-size: 12px; color: rgba(255, 255, 255, 0.5);">
                                        {{ formatTime(msg.timestamp) }}
                                    </div>
                                </n-space>
                            </n-card>
                        </n-space>
                    </n-scrollbar>
                </n-card>
            </n-space>
        </n-scrollbar>
    </n-card>
</template>

<script setup lang="ts">
import { NCard, NButton, NStatistic, NTag, NSpace, NScrollbar } from 'naive-ui';
import { onBeforeUnmount, onMounted, ref } from 'vue';

interface Message {
    role: 'user' | 'assistant';
    text: string;
    timestamp: number;
}

const connected = ref(false);
const recording = ref(false);
const processing = ref(false);
const messages = ref<Message[]>([]);
const currentTranscript = ref('');
const error = ref<string | null>(null);
const conversationHistory = ref<Array<{ role: string; content: string }>>([]);

// Edge Server WebSocket连接
let ws: WebSocket | null = null;
// Qwen实时ASR WebSocket连接
let realtimeAsrWs: WebSocket | null = null;
let stream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let mediaRecorder: MediaRecorder | null = null;
let isRealtimeMode = false;
const asrConfig = {
    provider: 'qwen-realtime',
    apiKey: 'sk-f1d4e80cee7f42298a6169b74c790b06',
    model: 'qwen3-asr-flash-realtime',
    enableServerVad: true,
    baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    language: 'zh',
};

// 连接到WebSocket
const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 尝试从当前host推断server地址，或使用默认值
    const host = window.location.hostname;
    const port = window.location.port ? parseInt(window.location.port) : (window.location.protocol === 'https:' ? 443 : 80);
    // 假设server在5283端口，或者在同域名下的5283端口
    const wsPort = port === 3000 ? 5283 : (port === 443 ? 5283 : port);
    const wsUrl = `${protocol}//${host}:${wsPort}/edge/conn`;
    console.log('连接WebSocket:', wsUrl);
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket连接已建立');
        connected.value = true;
        error.value = null;
    };

    ws.onmessage = (event) => {
        try {
            const text = typeof event.data === 'string' ? event.data : event.data.toString('utf8');
            
            // 处理ping/pong心跳消息
            if (text === 'ping') {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send('pong');
                }
                return;
            }
            
            // 尝试解析JSON
            let data: any;
            try {
                data = JSON.parse(text);
            } catch {
                // 如果不是JSON，直接返回
                console.warn('收到非JSON消息:', text);
                return;
            }
            
            handleWebSocketMessage(data);
        } catch (e) {
            console.error('处理消息失败:', e);
        }
    };

    ws.onerror = (err) => {
        console.error('WebSocket错误:', err);
        error.value = 'WebSocket连接错误';
        connected.value = false;
    };

    ws.onclose = () => {
        console.log('WebSocket连接已关闭');
        connected.value = false;
        // 3秒后重连
        setTimeout(() => {
            if (!ws || ws.readyState === WebSocket.CLOSED) {
                connectWebSocket();
            }
        }, 3000);
    };
};

// 处理WebSocket消息
const handleWebSocketMessage = (data: any) => {
    console.log('收到消息:', data);

    // 处理连接成功消息
    if (data.hello === 'edge') {
        console.log('连接成功，版本:', data.version);
        return;
    }

    // 处理pong响应
    if (data === 'pong' || (typeof data === 'string' && data === 'pong')) {
        return;
    }

    if (data.key === 'voice_chat') {
        if (data.error) {
            error.value = data.error;
            recording.value = false;
            processing.value = false;
            return;
        }

        if (data.result) {
            const { text, aiResponse, audio, streaming } = data.result;

            // 添加用户消息
            if (text) {
                const userMsg: Message = {
                    role: 'user',
                    text,
                    timestamp: Date.now(),
                };
                messages.value.push(userMsg);
                conversationHistory.value.push({ role: 'user', content: text });
            }

            // 添加AI回复
            if (aiResponse) {
                const aiMsg: Message = {
                    role: 'assistant',
                    text: aiResponse,
                    timestamp: Date.now(),
                };
                messages.value.push(aiMsg);
                conversationHistory.value.push({ role: 'assistant', content: aiResponse });
            }

            // 播放音频（非流式模式）
            if (audio && !streaming) {
                playAudio(audio);
            } else if (streaming) {
                // 流式模式：初始化流式播放器
                initStreamingPlayback();
            }

            recording.value = false;
            processing.value = false;
            currentTranscript.value = '';
        }
    } else if (data.key === 'voice_chat_audio') {
        // 处理流式音频分片
        if (data.chunk) {
            // 接收到音频分片，立即播放
            playAudioChunk(data.chunk);
        } else if (data.done) {
            // 流式传输完成
            finalizeStreamingPlayback();
            console.log('[流式播放] 音频流传输完成');
        }
    } else if (data.key === 'voice_asr' && data.result) {
        currentTranscript.value = data.result.text;
    }
};

// 切换录音状态
const toggleRecording = async () => {
    if (recording.value) {
        stopRecording();
    } else {
        await startRecording();
    }
};

// 发送会话更新配置到Qwen ASR
const sendSessionUpdate = () => {
    if (!realtimeAsrWs || realtimeAsrWs.readyState !== WebSocket.OPEN) return;
    
    const enableServerVad = asrConfig.enableServerVad !== false;
    const language = asrConfig.language || 'zh';
    
    const event = enableServerVad ? {
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
    } : {
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
    
    const eventStr = JSON.stringify(event);
    console.log('[实时ASR] 发送会话配置 (VAD:', enableServerVad, '):', eventStr);
    realtimeAsrWs.send(eventStr);
};

// 处理实时ASR消息
const handleRealtimeAsrMessage = (data: any) => {
    console.log('[实时ASR] 收到消息:', data);
    
    // 处理代理连接成功消息
    if (data.type === 'connection.opened') {
        console.log('[实时ASR] 代理连接已确认，准备发送会话配置');
        // 确保在连接完全就绪后发送会话配置并启动音频采集
        setTimeout(() => {
            console.log('[实时ASR] 发送会话配置');
            sendSessionUpdate();
            // 延迟启动音频采集，确保session.update先发送
            setTimeout(() => {
                console.log('[实时ASR] 启动音频采集');
                startRealtimeAudioCapture();
            }, 200);
        }, 100);
        return;
    }
    
    // 处理会话更新响应
    if (data.type === 'session.updated') {
        console.log('[实时ASR] 会话配置已确认:', data);
        return;
    }
    
    // 处理实时转录更新
    // Qwen ASR可能使用 text 事件（带stash字段）而不是 delta 事件
    if (data.type === 'conversation.item.input_audio_transcription.delta') {
        if (data.delta) {
            currentTranscript.value += data.delta;
        }
    }
    
    // 处理实时转录文本更新（Qwen ASR使用stash字段）
    if (data.type === 'conversation.item.input_audio_transcription.text') {
        // stash是临时文本，text是确认文本
        const displayText = data.stash || data.text || '';
        if (displayText) {
            currentTranscript.value = displayText;
            console.log('[实时ASR] 实时转录更新:', displayText);
        }
    }
    
    // 处理转录完成
    if (data.type === 'conversation.item.input_audio_transcription.completed') {
        const finalText = data.transcript || currentTranscript.value;
        console.log('[实时ASR] 最终转录:', finalText);
        
        if (!finalText || finalText.trim() === '') {
            console.log('[实时ASR] 转录为空，跳过AI对话');
            // 重置转录
            currentTranscript.value = '';
            return;
        }
        
        // 转录完成后，发送到AI进行对话
        if (ws && ws.readyState === WebSocket.OPEN) {
            const message = {
                key: 'voice_chat',
                text: finalText,
                format: 'text',
                conversationHistory: conversationHistory.value.slice(-10),
            };
            
            ws.send(JSON.stringify(message));
            console.log('已发送转录文本到服务器进行AI对话');
            processing.value = true;
        }
        
        // 重置转录
        currentTranscript.value = '';
        
        // 如果用户在等待停止，现在可以关闭连接了
        if (!recording.value && realtimeAsrWs) {
            console.log('[实时ASR] 转录完成，关闭连接');
            
            // 清除等待完成的超时
            if ((realtimeAsrWs as any).completionTimeoutId) {
                clearTimeout((realtimeAsrWs as any).completionTimeoutId);
                (realtimeAsrWs as any).waitingForCompletion = false;
            }
            
            realtimeAsrWs.close();
            realtimeAsrWs = null;
            isRealtimeMode = false;
            if (audioContext) {
                audioContext.close();
                audioContext = null;
            }
        }
        
        // VAD模式下会自动继续（如果还在录音），Manual模式下需要手动重启
        if (!asrConfig.enableServerVad && recording.value) {
            stopRecording();
        }
    }
    
    // 处理连接关闭
    if (data.type === 'connection.closed') {
        console.warn('[实时ASR] 连接已关闭:', data.code, data.reason);
        error.value = `ASR连接关闭: ${data.code} - ${data.reason || '未知原因'}`;
        recording.value = false;
        isRealtimeMode = false;
    }
    
    // 处理错误
    if (data.type === 'error') {
        console.error('[实时ASR] 错误:', data);
        error.value = data.error?.message || '实时ASR错误';
        recording.value = false;
    }
};

// 开始实时录音
const startRecording = async () => {
    try {
        // 获取麦克风权限
        stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                sampleRate: 16000,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
            }
        });
        
        // 创建AudioContext（16kHz采样率，符合Qwen要求）
        // 注意：浏览器的AudioContext可能不支持直接设置sampleRate，需要检查实际采样率
        audioContext = new AudioContext({ 
            sampleRate: 16000,
            latencyHint: 'interactive' 
        });
        
        // 如果浏览器不支持16kHz，使用默认采样率并在处理时重采样
        const actualSampleRate = audioContext.sampleRate;
        console.log('[实时ASR] AudioContext采样率:', actualSampleRate, '(目标: 16000)');
        if (actualSampleRate !== 16000) {
            console.warn('[实时ASR] 警告: 实际采样率', actualSampleRate, '与目标采样率16000不匹配');
        }
        
        // 连接到服务器端的ASR代理（代理会添加Authorization header）
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = window.location.port ? parseInt(window.location.port) : (window.location.protocol === 'https:' ? 443 : 80);
        const wsPort = port === 3000 ? 5283 : (port === 443 ? 5283 : port);
        const asrProxyUrl = `${protocol}//${host}:${wsPort}/asr-proxy`;
        
        console.log('连接ASR代理服务:', asrProxyUrl);
        
        realtimeAsrWs = new WebSocket(asrProxyUrl);
        
        realtimeAsrWs.onopen = () => {
            console.log('[实时ASR] 代理连接已建立，等待上游确认...');
            // 不立即发送session.update，等待connection.opened消息
            recording.value = true;
            error.value = null;
            currentTranscript.value = '';
        };
        
        realtimeAsrWs.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleRealtimeAsrMessage(data);
            } catch (e) {
                console.error('[实时ASR] 解析消息失败:', e);
            }
        };
        
        realtimeAsrWs.onerror = (err) => {
            console.error('[实时ASR] 连接错误:', err);
            error.value = '实时ASR连接错误';
            recording.value = false;
        };
        
        realtimeAsrWs.onclose = () => {
            console.log('[实时ASR] 连接已关闭');
            recording.value = false;
            isRealtimeMode = false;
        };
        
        isRealtimeMode = true;
    } catch (err: any) {
        console.error('无法访问麦克风:', err);
        error.value = `无法访问麦克风: ${err.message}`;
    }
};

// 开始实时音频采集并发送
// 根据官方示例：chunkSize=3200 bytes（约0.1秒的PCM16音频），每100ms发送一次
const startRealtimeAudioCapture = () => {
    if (!stream || !audioContext || !realtimeAsrWs) return;
    
    const source = audioContext.createMediaStreamSource(stream);
    // 使用较小的buffer size以匹配官方示例（约0.1秒的音频）
    // 16kHz采样率 * 2字节(PCM16) * 0.1秒 = 3200字节
    const bufferSize = 4096; // ScriptProcessor的bufferSize必须是2的幂次，4096是最接近的
    const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    let audioBuffer: Int16Array[] = [];
    let lastSendTime = 0;
    const sendInterval = 100; // 每100ms发送一次，匹配官方示例
    
    processor.onaudioprocess = (event) => {
        if (!isRealtimeMode || !realtimeAsrWs || realtimeAsrWs.readyState !== WebSocket.OPEN) {
            return;
        }
        
        const inputData = event.inputBuffer.getChannelData(0);
        
        // 转换为Int16 PCM格式
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            // 限制范围到 [-1, 1]
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // 累积音频数据
        audioBuffer.push(pcmData);
        
        // 每100ms发送一次（官方示例的频率）
        const now = Date.now();
        if (now - lastSendTime >= sendInterval) {
            // 合并累积的音频数据
            const totalLength = audioBuffer.reduce((sum, arr) => sum + arr.length, 0);
            const combined = new Int16Array(totalLength);
            let offset = 0;
            for (const arr of audioBuffer) {
                combined.set(arr, offset);
                offset += arr.length;
            }
            audioBuffer = []; // 清空缓冲区
            
            // 转换为base64
            const base64 = btoa(
                String.fromCharCode.apply(null, Array.from(new Uint8Array(combined.buffer)))
            );
            
            // 发送音频块（官方格式）
            const appendEvent = {
                event_id: `event_${Date.now()}`,
                type: 'input_audio_buffer.append',
                audio: base64
            };
            
            try {
                realtimeAsrWs.send(JSON.stringify(appendEvent));
                console.log(`[实时ASR] 发送音频块 (${combined.length} samples, ${base64.length} bytes base64)`);
            } catch (e) {
                console.error('[实时ASR] 发送音频失败:', e);
            }
            
            lastSendTime = now;
        }
    };
    
    source.connect(processor);
    processor.connect(audioContext.destination);
    
    // 保存processor以便停止时断开
    (realtimeAsrWs as any).processor = processor;
    (realtimeAsrWs as any).source = source;
};

// 停止录音
const stopRecording = () => {
    if (!isRealtimeMode) {
        // 如果不是实时模式，使用旧的MediaRecorder方式
        if (mediaRecorder && recording.value) {
            mediaRecorder.stop();
            recording.value = false;
            processing.value = true;
        }
        return;
    }
    
    // 停止实时模式
    console.log('[实时ASR] 停止录音，VAD模式:', asrConfig.enableServerVad);
    
    // 停止音频采集
    const currentStream = stream;
    if (currentStream) {
        const tracks = currentStream.getTracks();
        tracks.forEach((track) => {
            track.stop();
        });
        stream = null;
    }
    
    // 断开音频处理节点
    if ((realtimeAsrWs as any)?.processor) {
        try {
            (realtimeAsrWs as any).processor.disconnect();
            (realtimeAsrWs as any).source.disconnect();
        } catch (e) {
            console.warn('[实时ASR] 断开音频处理节点失败:', e);
        }
    }
    
    if (audioContext) {
        // 不立即关闭AudioContext，等待转录完成
        // audioContext.close();
        // audioContext = null;
    }
    
    if (realtimeAsrWs) {
        // 如果是Manual模式，发送commit事件
        if (!asrConfig.enableServerVad && realtimeAsrWs.readyState === WebSocket.OPEN) {
            const commitEvent = {
                event_id: `event_${Date.now()}`,
                type: 'input_audio_buffer.commit'
            };
            realtimeAsrWs.send(JSON.stringify(commitEvent));
            console.log('[实时ASR] 发送commit事件（Manual模式）');
        } else if (asrConfig.enableServerVad) {
            // VAD模式下，不发送commit，等待VAD自动检测完成
            console.log('[实时ASR] VAD模式，等待自动检测完成...');
            
            // 标记正在等待完成
            (realtimeAsrWs as any).waitingForCompletion = true;
            
            // 设置超时，如果8秒内没收到completed事件，则使用当前转录文本
            const timeoutId = setTimeout(() => {
                if (realtimeAsrWs && (realtimeAsrWs as any).waitingForCompletion) {
                    console.log('[实时ASR] 超时未收到完成事件，使用当前转录文本:', currentTranscript.value);
                    (realtimeAsrWs as any).waitingForCompletion = false;
                    
                    // 如果有转录文本，发送到AI
                    if (currentTranscript.value && currentTranscript.value.trim()) {
                        const finalText = currentTranscript.value.trim();
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            const message = {
                                key: 'voice_chat',
                                text: finalText,
                                format: 'text',
                                conversationHistory: conversationHistory.value.slice(-10),
                            };
                            ws.send(JSON.stringify(message));
                            console.log('[实时ASR] 超时后发送转录文本到服务器进行AI对话:', finalText);
                            processing.value = true;
                        }
                    }
                    
                    // 关闭连接
                    realtimeAsrWs.close();
                    realtimeAsrWs = null;
                    recording.value = false;
                    isRealtimeMode = false;
                    if (audioContext) {
                        audioContext.close();
                        audioContext = null;
                    }
                }
            }, 8000); // 增加超时时间到8秒
            
            // 保存超时ID以便在收到completed时清除
            (realtimeAsrWs as any).completionTimeoutId = timeoutId;
            
            // 不立即关闭，等待completed事件
            return;
        }
        
        // 如果不是VAD模式或连接已关闭，立即关闭
        if (realtimeAsrWs.readyState !== WebSocket.OPEN || !asrConfig.enableServerVad) {
            realtimeAsrWs.close();
            realtimeAsrWs = null;
            recording.value = false;
            isRealtimeMode = false;
            if (audioContext) {
                audioContext.close();
                audioContext = null;
            }
        }
    } else {
        recording.value = false;
        isRealtimeMode = false;
    }
};

// 流式播放相关变量
let streamingAudioContext: AudioContext | null = null;
let streamingAudioQueue: Float32Array[] = [];
let streamingIsPlaying = false;
let streamingSampleRate = 24000;

// 初始化流式播放
const initStreamingPlayback = () => {
    console.log('[流式播放] 初始化流式播放器');
    
    // 创建新的AudioContext用于流式播放
    streamingAudioContext = new AudioContext({ sampleRate: streamingSampleRate });
    streamingAudioQueue = [];
    streamingIsPlaying = false;
    
    console.log('[流式播放] AudioContext已创建，采样率:', streamingAudioContext.sampleRate);
};

// 播放音频分片（流式）
const playAudioChunk = (audioBase64: string) => {
    if (!streamingAudioContext) {
        console.error('[流式播放] AudioContext未初始化');
        return;
    }

    try {
        // 解码base64为PCM16数据
        const binaryString = atob(audioBase64);
        let bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // 确保字节数是偶数（PCM16需要2字节对齐）
        if (bytes.length % 2 !== 0) {
            bytes = bytes.slice(0, bytes.length - 1);
        }

        // 转换为Int16Array
        const pcmData = new Int16Array(bytes.buffer);
        
        // 转换为Float32（-1.0到1.0）
        const floatData = new Float32Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
            floatData[i] = pcmData[i] / 32768.0;
        }

        // 添加到队列
        streamingAudioQueue.push(floatData);
        
        console.log('[流式播放] 收到音频分片: %d samples', floatData.length);

        // 如果还没有开始播放，立即开始
        if (!streamingIsPlaying) {
            startStreamingPlayback();
        }
    } catch (err: any) {
        console.error('[流式播放] 处理音频分片失败:', err);
    }
};

// 开始流式播放
const startStreamingPlayback = () => {
    if (!streamingAudioContext || streamingIsPlaying) {
        return;
    }

    streamingIsPlaying = true;
    console.log('[流式播放] 开始播放音频流');

    // 使用定时器持续从队列中取数据并播放
    const scheduleNextChunk = () => {
        if (!streamingAudioContext || streamingAudioQueue.length === 0) {
            // 队列为空，等待更多数据（但保持playing状态）
            setTimeout(scheduleNextChunk, 10);
            return;
        }

        const chunk = streamingAudioQueue.shift();
        if (!chunk) {
            setTimeout(scheduleNextChunk, 10);
            return;
        }

        // 创建AudioBuffer
        const buffer = streamingAudioContext.createBuffer(1, chunk.length, streamingSampleRate);
        buffer.getChannelData(0).set(chunk);

        // 创建并播放
        const source = streamingAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(streamingAudioContext.destination);
        
        source.onended = () => {
            // 继续播放下一个分片
            setTimeout(scheduleNextChunk, 0);
        };

        try {
            source.start(0);
            console.log('[流式播放] 播放分片: %d samples', chunk.length);
        } catch (err: any) {
            console.error('[流式播放] 播放失败:', err);
            setTimeout(scheduleNextChunk, 10);
        }
    };

    scheduleNextChunk();
};

// 完成流式播放
const finalizeStreamingPlayback = () => {
    console.log('[流式播放] 等待队列清空...');
    
    // 等待队列中的所有数据播放完成
    const checkQueue = setInterval(() => {
        if (streamingAudioQueue.length === 0 && streamingIsPlaying) {
            // 额外等待一点时间确保最后的分片播放完成
            setTimeout(() => {
                console.log('[流式播放] 音频流播放完成');
                if (streamingAudioContext) {
                    streamingAudioContext.close().catch(err => 
                        console.error('[流式播放] 关闭AudioContext失败:', err)
                    );
                }
                streamingAudioContext = null;
                streamingIsPlaying = false;
                streamingAudioQueue = [];
            }, 500);
            clearInterval(checkQueue);
        }
    }, 100);
};

// 播放音频（base64编码的PCM16音频，非流式）
const playAudio = async (audioBase64: string) => {
    try {
        console.log('[播放音频] 开始播放，base64长度:', audioBase64.length);
        
        // 将base64解码为二进制数据
        const binaryString = atob(audioBase64);
        let bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // TTS Realtime返回的是PCM16格式，24kHz采样率
        // 需要手动创建AudioBuffer并填充PCM数据
        const sampleRate = 24000; // TTS Realtime使用24kHz
        const numChannels = 1; // 单声道
        
        // PCM16是16位（2字节）每个样本，确保字节数是偶数
        if (bytes.length % 2 !== 0) {
            console.warn('[播放音频] 音频数据长度不是偶数，丢弃最后一个字节');
            bytes = bytes.slice(0, bytes.length - 1);
        }
        
        const length = bytes.length / 2; // 样本数

        // 将PCM16字节数组转换为Int16Array（小端序）
        const pcmData = new Int16Array(bytes.buffer);
        
        // 创建AudioContext
        const audioContext = new AudioContext({ sampleRate });
        
        // 创建AudioBuffer
        const audioBuffer = audioContext.createBuffer(numChannels, length, sampleRate);
        
        // 将PCM16数据转换为Float32（-1.0到1.0范围）
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < length; i++) {
            // Int16范围是-32768到32767，转换为-1.0到1.0
            channelData[i] = pcmData[i] / 32768.0;
        }

        // 创建音频源并播放
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        console.log('[播放音频] 开始播放音频，长度:', length, 'samples, 时长:', (length / sampleRate).toFixed(2), '秒');

        return new Promise<void>((resolve, reject) => {
            source.onended = () => {
                console.log('[播放音频] 播放完成');
                audioContext.close().catch(err => console.error('[播放音频] 关闭AudioContext失败:', err));
                resolve();
            };
            
            try {
                source.start(0);
            } catch (err: any) {
                console.error('[播放音频] 启动播放失败:', err);
                audioContext.close().catch(() => {});
                reject(err);
            }
        });
    } catch (err: any) {
        console.error('[播放音频] 播放失败:', err);
        error.value = `播放音频失败: ${err.message}`;
    }
};

// 清空历史
const clearHistory = () => {
    messages.value = [];
    conversationHistory.value = [];
    currentTranscript.value = '';
};

// 格式化时间
const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN');
};

onMounted(() => {
    connectWebSocket();
});

onBeforeUnmount(() => {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (realtimeAsrWs) {
        realtimeAsrWs.close();
        realtimeAsrWs = null;
    }
    const currentStream = stream;
    if (currentStream) {
        const tracks = currentStream.getTracks();
        tracks.forEach((track) => {
            track.stop();
        });
        stream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaRecorder && recording.value) {
        mediaRecorder.stop();
        mediaRecorder = null;
    }
});
</script>


