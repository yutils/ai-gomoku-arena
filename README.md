# AI × AI 五子棋 · 大模型对战平台

**简体中文** | [English](README.en.md)

让多个 AI（或人类、内置算法）互相对弈五子棋，并完整记录每一项性能数据：思考用时、首字延迟、token 消耗与速度、MTP 草稿接受率、CPU/GPU 占用……

- **黑方、白方各自选人**：任意 AI 模型 / 内置算法（三档难度）/ 人类
- **实时看思考**：流式显示模型推理过程，可展开每一步的原始思考
- **真实指标**：每步与累计的用时、TTFT、输入/输出 tokens、tok/s、缓存命中、MTP 草稿
- **历史回放**：每局棋谱、指标、思考过程全部留存，可回放、导入导出
- **系统监控**：llama.cpp 服务（/props /slots /metrics）+ 本机 CPU/GPU/显存/进程

#### 截图
![Img](doc/image1.jpg)

## 这是静态网站吗？要不要编译？

**前端是 100% 纯静态页面**：没有框架、没有构建步骤、没有任何 npm 依赖，`index.html + css + js` 直接由浏览器加载，离线可用。

项目里唯一的"服务端"是一个**零依赖的单文件 Node 脚本** [server/server.js](server/server.js)，只做三件事：

1. 托管上面的静态页面（等价于一个 http-server）
2. **CORS 代理** `/proxy`：部分推理服务（如 Strata）不返回跨域头，浏览器直连会被拦截，经它转发即可
3. **系统信息** `/api/sysinfo`：用 Node + Windows 性能计数器采集 CPU / 内存 / GPU 占用与 llama-server 进程数据

所以：**不需要编译、不需要打包、不需要 `npm install`**。有 Node（≥ 18，本机 v24 实测）就能直接运行。

三种部署方式：

| 方式 | 命令 | 能得到什么 |
|---|---|---|
| 本机使用（推荐） | 双击 `启动服务.bat`，或 `node server/server.js` | 全部功能（代理 + 系统监控） |
| 局域网访问 | 默认监听 `0.0.0.0`，其他设备访问 `http://<本机IP>:8899` | 全部功能（首次需放行 Windows 防火墙） |
| 纯静态托管（Nginx / GitHub Pages 等） | 只部署 `index.html css/ js/` | 页面能跑，但**失去** CORS 代理（Strata 这类服务不可用）与 CPU/GPU 监控 |

想限制只允许本机访问：`HOST=127.0.0.1 node server/server.js`；换端口：`node server/server.js 9000`。

## 快速开始

```bat
启动服务.bat          :: 等价于 node server/server.js，并自动打开浏览器
:: http://127.0.0.1:8899
```

首次打开已预置两个服务提供方（可删可改）：

- **本地 llama.cpp** — `http://127.0.0.1:8080/v1`，模型 `bonsai2-27b`
- **Strata** — `http://10.1.1.8:8080/v1`，模型 `qwen3.8-flash-next-iq3_s`（已设为"始终经本地代理"）

然后到「对战台」：分别选好黑方、白方（AI 模型 / 传统算法 / 人类），点「开始对局」。

## 接入任意模型服务

「模型配置」页按 DeepSeek Harness 的模型配置模型设计：

- **Provider**：ID（创建后不可改）、显示名、Base URL（填到 `/v1` 即可）、API 协议（OpenAI Chat Completions）、API Key、网络策略、超时、自定义请求头、额外请求参数
- **Model**：模型 ID、显示名、上下文窗口、最大输出、temperature / top_p / top_k、是否推理模型
- 「获取可用模型」：探测 `/v1/models`；「连通性测试」：真实发一次请求看时延与速度

要点：

- **API Key 只保存在浏览器本地**（localStorage），保存后界面不再显示明文；导出的棋谱**不含**任何密钥
- **网络策略**：`自动`（先直连，被跨域拦截时自动改走本地代理）、`始终经本地代理`（服务无 CORS 头时选它，如 Strata）、`始终直连`（服务支持 CORS，如 llama.cpp 默认 `--cors-origins *`）
- **额外请求参数**（JSON，会合并进请求体）：思考型模型强烈建议按需使用，可显著提速
  - `{"chat_template_kwargs": {"enable_thinking": false}}` — 关闭长思考（llama.cpp + Qwen 系模板）
  - `{"reasoning_effort": "low"}` — 降低推理强度（支持该参数的服务）
- **llama.cpp** 启动时加 `--metrics`，监控页才能显示 tokens 计数、KV 缓存、请求队列、MTP 草稿接受率等完整指标（不加也能用，只是指标少）

## 对局机制

- 15×15 无禁手（尺寸可选 13/15/19），黑先，横竖斜五连或以上获胜，满盘和棋
- 参赛方：**AI 模型** / **内置算法**（初级=随机偏好、中级=启发式攻防、高级=Minimax α-β）/ **人类**
- 控制栏：开始 / 暂停 / 继续 / 悔棋 / 终止 / 再来一局；对局中随时可把任一方「接管为人类」，之后可「恢复 AI」
- 规则与容错（「对局设置」里可改）：
  - 单步超时（默认 300s）：预算按剩余重试次数均分，避免一次慢请求吃掉全部机会
  - 非法落子重试（默认 3 次）：把占用/越界信息反馈给模型重新给坐标
  - 异常处理：**内置算法兜底代下**（标记"兜底"）或**直接判负**
  - 提示词语言：中文 / English；是否要求模型先做局面分析（思考模式）
  - 模型输出被长度截断时，会自动回退解析它的思考过程里最后的坐标

## 指标口径

- 每步：总用时、TTFT（首字延迟）、输入/输出 tokens、生成速度（tok/s）、prompt 处理速度、缓存命中 tokens、MTP 草稿数/接受数
- 优先取服务端返回的 `usage` / `timings`（llama.cpp 与 Strata 都返回），服务端不返回时按字符估算并标 ≈
- 累计：每方总用时、总 tokens、平均速度、平均首字；历史页有双方汇总对比

## 系统监控

- **服务数据**：`/props`（模型文件、上下文、构建版本）、`/health`、`/slots`（槽位占用/状态/MTP）、`/metrics`
- **本机资源**：CPU（型号/核数/占用）、内存、GPU（总占用 + 引擎明细 + 显存/共享内存）、llama-server 进程（内存/CPU/显存/GPU 占用）
- 采集方式：Node `os` 模块 + Windows 性能计数器（`Get-Counter`），AMD / Intel / NVIDIA 显卡都支持（本机实测 AMD Radeon 780M）

## 目录结构

```
AIvsAI/
├── index.html                 # 单页入口（四个视图：对战台/模型配置/历史/监控）
├── css/main.css               # 设计系统（深色科技风，无外部依赖）
├── js/
│   ├── core/board.js          # 棋盘、胜负判定、坐标换算（A-O × 1-15）
│   ├── core/game.js           # 对局状态机：交替思考/重试/兜底/悔棋/接管/统计
│   ├── ai/openai.js           # OpenAI 兼容流式适配器（SSE/TTFT/代理回退/超时）
│   ├── ai/prompt.js           # 提示词与棋盘序列化（中/英）
│   ├── ai/parse.js            # 落子解析（JSON / MOVE: / 裸坐标 / 数字对）
│   ├── ai/engine.js           # 传统算法（启发式 + Minimax，Worker 运行）
│   ├── store/providers.js     # Provider/Model/Key 配置存储与模型探测
│   ├── store/db.js            # IndexedDB 历史记录
│   └── ui/                    # 四个页面 + 棋盘组件 + 迷你图表
├── server/server.js           # 零依赖辅助服务（静态托管 / CORS 代理 / 系统信息）
├── tests/                     # node:test 单元测试（棋盘/解析/算法）
├── 启动服务.bat               # 一键启动并打开浏览器
└── package.json               # 仅用于 npm test 与 npm start，无依赖
```

## 测试

```bat
npm test        :: node --test，24 个用例（棋盘/胜负/坐标解析/落子解析/算法攻防）
```

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 调用模型报"网络请求失败" | 服务无 CORS 头。到「模型配置」把该服务的网络策略改成"始终经本地代理"；同时确认页面是通过本服务打开的（顶部胶囊显示"本地服务已连接"） |
| 顶部胶囊显示"未连接本地服务" | 你是用 file:// 或别的静态服务器打开的页面。改用 `启动服务.bat` / `node server/server.js` 打开 |
| 监控页显示"需要 --metrics" | llama-server 启动参数里加上 `--metrics` 后重启 |
| 监控页"无法连接" | llama-server 未启动或地址/端口不对；确认 `/health` 能访问 |
| 对局中频繁"兜底代下" | 模型太慢或反复给非法坐标：调大单步超时、降低最大输出、或按上文关闭思考模式；也可能是该量化模型能力有限 |
| 端口 8899 被占用 | `node server/server.js 9000` 换端口 |
| 局域网设备打不开 | 首次运行需在 Windows 防火墙弹窗中允许 Node 访问专用网络；并确认用 `http://<本机IP>:8899` 而非 127.0.0.1 |
| 历史记录消失 | 记录存在浏览器的 IndexedDB 中，清理浏览器数据/更换浏览器会丢失，建议在历史页「导出全部」备份 |

## 安全说明

- 这是**本地工具**：API Key 只存在你自己浏览器的 localStorage 里，服务端不保存任何密钥
- 若监听 `0.0.0.0`（默认），局域网内其他设备也能使用 `/proxy`（可转发任意 http/https 请求）与系统信息，**建议仅在家庭/受信内网使用**；不需要时用 `HOST=127.0.0.1 node server/server.js` 限制本机