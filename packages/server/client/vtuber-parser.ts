import { Logger } from '@ejunz/utils';
import { VTuberControl } from './vtuber-server';

const logger = new Logger('vtuber-parser');

/**
 * 从AI回复中提取VTuber控制指令
 * 支持两种格式：
 * 1. JSON块格式：```json { "vtuber": {...} } ```
 * 2. 自然语言解析：通过关键词识别动作和表情
 */
export function parseVTuberControls(aiResponse: string): VTuberControl[] {
    const controls: VTuberControl[] = [];

    // 方法1：尝试提取JSON格式的控制指令
    const jsonMatch = aiResponse.match(/```json\s*([\s\S]*?)```/) || aiResponse.match(/```\s*([\s\S]*?)```/);
    if (jsonMatch) {
        try {
            const jsonStr = jsonMatch[1] || jsonMatch[2];
            const parsed = JSON.parse(jsonStr);
            if (parsed.vtuber) {
                if (Array.isArray(parsed.vtuber)) {
                    controls.push(...parsed.vtuber);
                } else {
                    controls.push(parsed.vtuber);
                }
                logger.info('从JSON块提取到 %d 个VTuber控制指令', controls.length);
                return controls;
            }
        } catch (err: any) {
            logger.debug('解析JSON块失败: %s', err.message);
        }
    }

    // 方法2：尝试提取内联JSON对象
    const inlineJsonMatch = aiResponse.match(/\{"vtuber":\s*\{[^}]+\}\}/);
    if (inlineJsonMatch) {
        try {
            const parsed = JSON.parse(inlineJsonMatch[0]);
            if (parsed.vtuber) {
                if (Array.isArray(parsed.vtuber)) {
                    controls.push(...parsed.vtuber);
                } else {
                    controls.push(parsed.vtuber);
                }
                logger.info('从内联JSON提取到 %d 个VTuber控制指令', controls.length);
                return controls;
            }
        } catch (err: any) {
            logger.debug('解析内联JSON失败: %s', err.message);
        }
    }

    // 方法3：自然语言解析 - 基于关键词识别动画
    // 注意：我们直接识别动画，而不是分别识别表情和动作
    // 因为用户模型的动画已经包含表情+动作的组合
    const text = aiResponse.toLowerCase();
    
    // 识别动画（扩展关键词和动作类型）
    // 注意：优先匹配组合动作（表情+动作），再匹配单一动作
    const actionMap: { [key: string]: string } = {
        // === 用户模型的实际动画（优先级最高）===
        // 1. 开心+点头
        '开心点头': 'happy_nod', '开心地点头': 'happy_nod', '高兴点头': 'happy_nod',
        '点头开心': 'happy_nod', '点头表示开心': 'happy_nod',
        
        // 2. 疑惑
        '疑惑': 'confused', '困惑': 'confused', '疑问': 'confused', '不解': 'confused',
        '疑惑的表情': 'confused', '感到疑惑': 'confused',
        '怎么': 'confused',
        
        // 3. 摇头晃脑
        '摇头晃脑': 'shake_head_around', '摇头': 'shake_head_around',
        '晃脑袋': 'shake_head_around', '摇头表示': 'shake_head_around',
        '不是': 'shake_head_around', '不对': 'shake_head_around', '不行': 'shake_head_around',
        '不会': 'shake_head_around', '不能': 'shake_head_around',
        
        // 4. 平静+害羞
        '害羞': 'shy', '羞涩': 'shy', '不好意思': 'shy',
        '平静害羞': 'shy', '害羞地': 'shy', '羞怯': 'shy',
        '平静': 'shy', // 映射到shy，因为用户有"平静"热键
        
        // 5. 发呆+歪头（原"微笑+思考"已改为"发呆+歪头"）
        '思考': 'idle_tilt_head', '沉思': 'idle_tilt_head', '想': 'idle_tilt_head',
        '微笑思考': 'idle_tilt_head', '边想边笑': 'idle_tilt_head',
        '小脑袋': 'idle_tilt_head', '脑袋': 'idle_tilt_head', '脑袋瓜': 'idle_tilt_head',
        '发呆': 'idle_tilt_head', '歪头': 'idle_tilt_head', '发呆歪头': 'idle_tilt_head',
        '发呆+歪头': 'idle_tilt_head', '呆滞': 'idle_tilt_head', '出神': 'idle_tilt_head',
        '该不会': 'idle_tilt_head', '不会是': 'idle_tilt_head', '是不是': 'idle_tilt_head',
        
        // 6. 开心+手舞足蹈
        '手舞足蹈': 'excited_dance', '高兴地手舞足蹈': 'excited_dance',
        '开心手舞足蹈': 'excited_dance', '兴奋地手舞足蹈': 'excited_dance',
        '跳舞': 'excited_dance', '手舞': 'excited_dance',
        
        // 7. 惊讶+眨眼
        '眨眼': 'surprised_blink', '惊讶眨眼': 'surprised_blink',
        '吃惊地眨眼': 'surprised_blink', '眨眼睛': 'surprised_blink',
        
        // 8. 兴奋+挥手
        '挥手': 'excited_wave', '招手': 'excited_wave', '兴奋挥手': 'excited_wave',
        '高兴挥手': 'excited_wave', '兴奋地挥手': 'excited_wave',
        '挥手告别': 'excited_wave', '挥手打招呼': 'excited_wave',
        
        // 9. 吃惊
        '吃惊': 'surprised', '惊讶': 'surprised', '震惊': 'surprised',
        '大吃一惊': 'surprised', '非常惊讶': 'surprised',
        
        // 10. 难过
        '难过': 'sad', '悲伤': 'sad', '伤心': 'sad', '沮丧': 'sad',
        '失落': 'sad', '不开心': 'sad',
        
        // === 通用动作（作为备选）===
        '指向': 'point', '指着': 'point', '指向某处': 'point',
        '拍手': 'clap', '鼓掌': 'clap', '拍掌': 'clap',
        '竖起大拇指': 'thumbs_up', '点赞': 'thumbs_up',
        '比心': 'heart', '爱心': 'heart',
        '鞠躬': 'bow', '弯腰': 'bow',
        '耸肩': 'shrug',
        '转身': 'turn', '转头': 'turn',
        '伸懒腰': 'stretch', '伸展': 'stretch',
        '坐下': 'sit', '站起': 'stand',
        '跳跃': 'jump', '跳': 'jump',
    };

    // 按文本顺序识别多个动画，形成动画序列（支持AI在文本中嵌入情绪关键词）
    // 按关键词在文本中的出现顺序提取动画，而不是一次性提取所有
    const detectedAnimations: string[] = [];
    const animationPositions: Array<{ animation: string; position: number; keyword: string }> = [];
    
    // 第一步：找出所有匹配的关键词及其在文本中的位置
    for (const [keyword, animation] of Object.entries(actionMap)) {
        // 查找所有出现位置（支持多次出现）
        let searchIndex = 0;
        while (true) {
            const pos = text.indexOf(keyword, searchIndex);
            if (pos === -1) break;
            
            animationPositions.push({
                animation,
                position: pos,
                keyword,
            });
            searchIndex = pos + keyword.length;
        }
    }
    
    // 第二步：按位置排序，保留顺序，但避免连续重复
    animationPositions.sort((a, b) => a.position - b.position);
    
    // 第三步：按顺序添加动画，跳过连续重复的动画
    let lastAnimation: string | null = null;
    for (const { animation, position, keyword } of animationPositions) {
        // 跳过连续重复的动画（如果上一个动画和当前相同，跳过）
        if (animation !== lastAnimation || detectedAnimations.length === 0) {
            // 避免整体重复（确保序列中不会出现重复动画）
            if (!detectedAnimations.includes(animation)) {
                detectedAnimations.push(animation);
                controls.push({
                    type: 'action',
                    action: {
                        name: animation,
                        duration: 2000, // 动画持续时间
                        intensity: 0.6,
                        blend: true,
                    },
                });
                lastAnimation = animation;
            } else if (detectedAnimations[detectedAnimations.length - 1] !== animation) {
                // 如果序列中已有，但上一个不是它，允许添加（支持序列中重复，但不相邻）
                detectedAnimations.push(animation);
                controls.push({
                    type: 'action',
                    action: {
                        name: animation,
                        duration: 2000,
                        intensity: 0.6,
                        blend: true,
                    },
                });
                lastAnimation = animation;
            }
        }
    }
    
    // 如果只检测到一个动画，尝试根据AI回复的情感色彩添加补充动画
    if (detectedAnimations.length === 1) {
        // 根据文本内容和已检测的动画，智能添加一个相关的补充动画
        const currentAnimation = detectedAnimations[0];
        let complementaryAnimation: string | null = null;
        
        // 根据当前动画和文本内容，选择互补动画
        if (currentAnimation === 'idle_tilt_head') {
            // 如果检测到"发呆+歪头"，可以根据文本添加其他动画
            if (text.includes('开心') || text.includes('高兴') || text.includes('快乐')) {
                complementaryAnimation = 'happy_nod';
            } else if (text.includes('疑惑') || text.includes('困惑')) {
                complementaryAnimation = 'confused';
            } else if (text.includes('挥手') || text.includes('招手')) {
                complementaryAnimation = 'excited_wave';
            }
        } else if (currentAnimation === 'confused') {
            // 如果检测到"疑惑"，可以添加"思考"作为后续
            complementaryAnimation = 'idle_tilt_head';
        } else if (currentAnimation === 'happy_nod') {
            // 如果检测到"开心+点头"，可以添加"挥手"或"思考"
            if (text.includes('挥手') || text.includes('告别')) {
                complementaryAnimation = 'excited_wave';
            } else {
                complementaryAnimation = 'idle_tilt_head';
            }
        }
        
        // 如果找到了互补动画，添加到序列中
        if (complementaryAnimation && !detectedAnimations.includes(complementaryAnimation)) {
            controls.push({
                type: 'action',
                action: {
                    name: complementaryAnimation,
                    duration: 2000,
                    intensity: 0.6,
                    blend: true,
                },
            });
            logger.debug('添加互补动画: %s（基于已检测的 %s）', complementaryAnimation, currentAnimation);
        }
    }
    
    // 确保动画序列不包含重复（双重保障）
    const uniqueAnimations = new Set<string>();
    const uniqueControls = controls.filter(c => {
        if (c.type === 'action' && c.action) {
            if (uniqueAnimations.has(c.action.name)) {
                return false; // 重复，移除
            }
            uniqueAnimations.add(c.action.name);
            return true; // 不重复，保留
        }
        return true; // 非动作控制，保留
    });
    controls.length = 0;
    controls.push(...uniqueControls);

    // 必须生成动画控制：如果没有任何动画，根据AI回复的情感色彩智能生成默认动画序列
    const actionControls = controls.filter(c => c.type === 'action' && c.action);
    if (actionControls.length === 0 && aiResponse.trim().length > 0) {
        // 根据AI回复的情感色彩，智能生成2-3个不同的动画序列（模拟AI在文本中嵌入多个情绪）
        let defaultAnimations: string[] = [];
        
        // 分析文本情感，选择合适的动画序列（模拟在文本不同位置嵌入情绪）
        if (text.includes('开心') || text.includes('高兴') || text.includes('快乐') || text.includes('兴奋')) {
            // 模拟：先疑惑/思考，然后开心回应
            if (text.includes('疑惑') || text.includes('困惑')) {
                defaultAnimations = ['confused', 'happy_nod']; // 疑惑，然后开心+点头
            } else {
                defaultAnimations = ['idle_tilt_head', 'happy_nod']; // 思考，然后开心+点头
            }
        } else if (text.includes('疑惑') || text.includes('困惑') || text.includes('疑问') || text.includes('不懂')) {
            defaultAnimations = ['confused', 'idle_tilt_head']; // 疑惑，然后思考
        } else if (text.includes('挥手') || text.includes('招手') || text.includes('告别') || text.includes('拜拜')) {
            defaultAnimations = ['idle_tilt_head', 'excited_wave']; // 思考，然后兴奋+挥手
        } else if (text.includes('难过') || text.includes('悲伤') || text.includes('伤心')) {
            defaultAnimations = ['sad', 'idle_tilt_head']; // 难过，然后思考
        } else if (text.includes('惊讶') || text.includes('吃惊') || text.includes('震惊')) {
            defaultAnimations = ['surprised', 'surprised_blink']; // 惊讶，然后惊讶+眨眼
        } else if (text.includes('摇头') || text.includes('不') || text.includes('不是')) {
            defaultAnimations = ['shake_head_around', 'idle_tilt_head']; // 摇头，然后思考
        } else if (text.includes('害羞') || text.includes('羞涩')) {
            defaultAnimations = ['shy', 'happy_nod']; // 害羞，然后开心+点头
        } else {
            // 默认序列：思考，然后开心+点头（最常见的组合）
            defaultAnimations = ['idle_tilt_head', 'happy_nod'];
        }
        
        // 添加默认动画序列到控制指令（按照顺序）
        for (const animName of defaultAnimations) {
            controls.push({
                type: 'action',
                action: {
                    name: animName,
                    duration: 2000,
                    intensity: 0.6,
                    blend: true,
                },
            });
        }
        
        logger.debug('未检测到动画关键词，根据文本情感生成默认动画序列: %s（建议AI在文本中嵌入情绪关键词以获得更精确的动画控制）', defaultAnimations.join(', '));
    } else if (actionControls.length > 0) {
        // 如果检测到了动画，记录它们在文本中的顺序
        const animationNames = actionControls.map(c => c.action?.name).filter(Boolean).join(', ');
        logger.info('🎭 按文本顺序检测到动画序列: %s（将在语音播放时依次播放）', animationNames);
    }

    // 确保有说话状态
    const hasSpeaking = controls.some(c => c.type === 'speaking');
    if (!hasSpeaking) {
        controls.push({
            type: 'speaking',
            speaking: {
                isSpeaking: true,
                volume: 0.7,
                pitch: 0.5,
            },
        });
    }

    return controls;
}

/**
 * 提取纯文本（去除控制指令标记和括号内的关键词）
 * 用于TTS播放，避免读出"（思考）"、"（摇头）"等关键词
 */
export function extractCleanText(aiResponse: string): string {
    // 移除JSON代码块
    let text = aiResponse.replace(/```json\s*[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '');
    // 移除内联JSON对象
    text = text.replace(/\{"vtuber":\s*\{[^}]+\}\}/g, '');
    // 移除括号及其内容（如"（思考）"、"（摇头）"、"（点头）"等）
    // 支持中文括号（全角）和英文括号（半角）
    // 匹配模式：先移除中文括号，再移除英文括号
    text = text.replace(/（[^）]*）/g, ''); // 中文括号（全角）
    text = text.replace(/\([^)]*\)/g, ''); // 英文括号（半角）
    // 处理连续多个空格和标点后的空格
    text = text.replace(/\s+([，。！？、])/g, '$1'); // 移除标点前的空格
    text = text.replace(/\s{2,}/g, ' '); // 多个连续空格合并为一个
    // 清理多余空白（多个空格/换行合并为单个空格）
    text = text.trim().replace(/\s+/g, ' ');
    return text;
}

