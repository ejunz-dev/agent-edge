# 语音对话测试客户端

这是一个用于测试语音对话功能的Vue客户端应用。

## 功能

- ✅ WebSocket实时连接
- ✅ 浏览器录音（MediaRecorder）
- ✅ 音频发送到服务器
- ✅ 实时显示对话历史
- ✅ 自动播放AI回复的语音

## 开发

```bash
cd packages/voice-client/frontend
npm install
npm run dev
```

访问 http://localhost:3000

## 配置

默认连接到 `ws://localhost:5283/edge/conn`，如果需要修改，可以修改 `VoiceTest.vue` 中的 `connectWebSocket` 函数。

## 使用说明

1. 打开页面后，会自动尝试连接WebSocket
2. 点击"开始录音"按钮，允许浏览器访问麦克风
3. 说话后点击"停止录音并发送"
4. 等待服务器处理（ASR → AI → TTS）
5. AI回复的语音会自动播放
6. 对话历史会显示在下方

