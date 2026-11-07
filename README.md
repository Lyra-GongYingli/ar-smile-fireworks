# 笑一笑 AR · Smile Rain, Laugh Fireworks

浏览器里的直播间 AR 互动原型：**微笑时屏幕下雨，大笑时烟花在头顶炸开，火花落到头上会弹开，晃头能把火花甩走。** 人脸追踪、表情判定、物理和渲染全部在本机完成，画面不上传。

A browser AR prototype for a LIVE room: smile and it rains, laugh and fireworks burst above your head; the sparks bounce off your head. Everything runs on-device.

- **Live demo**：<https://lyra-gongyingli.github.io/ar-smile-fireworks/>（手机或电脑浏览器打开，允许摄像头）
- **没有摄像头**：<https://lyra-gongyingli.github.io/ar-smile-fireworks/?demo=1> 演示模式，可拖动头像，按住按钮或键盘 S / L 模拟微笑、大笑
- **性能面板**：点右下角「性能」，或加 `?hud=1`，会显示帧率、推理耗时、检测频率和头部碰撞体轮廓

![演示模式：大笑时烟花在头顶炸开，火花落在头上滑落](docs/demo.jpg)

## 判定规则

PM 的需求只有一句话，原型先把它翻译成可验收的规则。分数是 MediaPipe 输出的 blendshape，先减去每个人自己的静息基线。

| 状态 | 进入条件 | 退出条件 | 效果 |
| --- | --- | --- | --- |
| 微笑 | 嘴角上扬 ≥ 0.42，累计 120 ms | < 0.28 持续 220 ms | 下雨，雨量随笑容变大；雨滴打到头顶溅起水花 |
| 大笑 | 嘴角 ≥ 0.35 且张嘴 ≥ 0.30，累计 150 ms（漏桶计时，“哈哈哈”的开合不会打断） | 张嘴 < 0.16 或嘴角 < 0.22 持续 380 ms | 立即放 3 朵烟花，之后每 0.45–0.9 s 再放，笑得越大越密；雨减弱 |

以下情况**不会**触发：说话（嘴角不够）、打哈欠（只张嘴）、“O”型嘴惊讶（funnel/pucker 一票否决）、单帧抖动、侧脸超过约 40°（分数不可靠，保持当前状态）。规则和这些反例都有单测（`tests/expression.test.js`）。

## 架构

```
摄像头 640×480@30 ──► FaceLandmarker (WASM + WebGL, GPU 优先)
                        │  只在“有新帧”时推理；推理占主线程 ≤ 40%；无脸时降到 5 次/秒
                        ├─► 478 个关键点 ──► 头部椭圆碰撞体（cover 裁切 + 镜像映射，One Euro 平滑，速度外推 ≤ 50 ms）
                        └─► 52 个 blendshape ──► 表情状态机（个人基线 / 迟滞 / 漏桶计时 / 侧脸门控）
                                                   │
                     特效发射器（雨 / 烟花）◄────────┘
                                  │
          粒子池（定长 TypedArray，交换删除，零分配）──► 椭圆碰撞（按头部速度反弹）
                                  │
                 WebGL 点精灵：所有粒子一次上传、一次 draw call（无 WebGL 时退回 Canvas 2D）
```

| 文件 | 职责 |
| --- | --- |
| `src/tracker.js` | 模型下载（带进度）、GPU→CPU 回退、推理调度 |
| `src/face.js` | 关键点 → 屏幕坐标头部椭圆；One Euro 滤波 |
| `src/expression.js` | blendshape → 无 / 微笑 / 大笑 |
| `src/particles.js` | 粒子池、物理、椭圆碰撞 |
| `src/effects.js` | 雨和烟花的发射节奏、落点 |
| `src/renderer-gl.js` / `renderer-2d.js` | 渲染 |
| `src/main.js` | 主循环、模式切换、画质档位自适应 |

## 性能

推理是成本大头，粒子不是：3000 个粒子在 WebGL 路径上每帧 JS 约 0.5 ms，一次人脸推理约 10 ms。所以优化集中在“少推理、推理不卡渲染”。

- **只推理新帧**：用 `requestVideoFrameCallback` 判断摄像头是否出了新帧。120 Hz 屏幕上的 rAF 是摄像头帧率的 4 倍，不判断就会对同一帧重复推理。
- **推理预算**：按实测耗时把推理频率限制在主线程 ≤ 40%，最低 8 次/秒；前 3 帧（编译着色器）不计入。
- **无脸待机**：1.5 s 没检测到人脸，降到 5 次/秒。
- **零分配热路径**：粒子是定长 TypedArray，删除用交换，渲染一次上传一次 draw call。
- **画质档位**：按帧间隔自动升降（粒子上限、像素比），以屏幕自身刷新率为基准，iOS 低电量模式锁 30 Hz 时不会误降档。
- **能力检测在下载之前**：MediaPipe 1.2 只提供 SIMD 版 wasm，CPU 推理也要用 WebGL 转换画面。缺任一项的设备不下载模型，只下 0.24 MB，直接给出原因和演示模式。

实测（Apple Silicon 笔记本，Chrome 无头模式 + Metal，假摄像头注入人脸视频）：

| 场景 | 帧率 | 每帧 JS | 单次推理 | 检测频率 |
| --- | --- | --- | --- | --- |
| 桌面 1280×800，有人脸 | 60 | 5.5 ms | 10 ms（GPU） | 28–32 次/秒 |
| 手机尺寸 390×844，CPU 降速 4 倍 | 60 | 6 ms | 16 ms | 约 20 次/秒（预算自动降频） |
| 画面里没有人脸 | 60 | 0.4–1 ms | 7 ms | 4–8 次/秒（待机） |
| 演示模式，约 3000 个粒子 | 60 | 0.5 ms（Canvas 2D 回退 1.2 ms） | — | — |

首次加载原始体积 18.9 MB（wasm 14.6 MB + 模型 3.8 MB + 脚本 0.6 MB），GitHub Pages 会 gzip，实测传输 7.7 MB；10 分钟缓存内再次打开约 0.3 秒就绪。模型和 wasm 与页面同源托管，不依赖海外 CDN。

## 边缘情况

| 情况 | 处理 |
| --- | --- |
| 拒绝摄像头权限 / 没有摄像头 / 被会议软件占用 | 分别提示原因，可重试或进入演示模式 |
| 非 HTTPS、微信等 App 内置浏览器 | 提示用 HTTPS 链接或系统浏览器打开 |
| 没有 WebGL、没有 Wasm SIMD（如 iOS 16.4 以前） | 下载前拦截，说明原因，保留演示模式 |
| GPU 推理初始化失败或运行中失败 | 自动改用 CPU 重建 |
| 没检测到人脸、侧脸过大 | 顶部提示调整姿势；效果暂停而不是误触发 |
| 有人天生“笑眯眯” | 个人基线自动吸收静息值（上限 0.3，真笑不会被吸收） |
| 竖屏手机裁掉画面两侧 | 关键点按 `object-fit: cover` 同样的裁切映射，碰撞体不偏移 |
| 切到后台 | 停止渲染和推理 |
| 低端机掉帧 | 自动降画质档位 |
| 光敏 | 爆炸闪光每朵只有一次、约 120 px，频率 ≤ 3 次/秒（WCAG 2.3.1） |

## 本地运行与测试

```bash
npm run serve   # http://localhost:5173（localhost 视为安全上下文，可用摄像头）
npm test        # 32 个单测：表情规则、碰撞物理、坐标映射、画质调节
```

调试参数：`?hud=1` 性能面板（也可点右下角按钮）、`?demo=1` 演示模式、`?tier=0|1|2` 固定画质档、`?cpu=1` 强制 CPU 推理、`?renderer=2d` 强制 Canvas 2D、`?caps=gl` 模拟没有 WebGL。

## 第三方

- [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) 1.2.2 与 [Face Landmarker 模型](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker)，Apache-2.0，见 `vendor/mediapipe/README.md`。
