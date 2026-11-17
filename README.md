# 远程 React 渲染最小 Demo

React 跑在 Node 进程里，界面画在浏览器里。

- **Node 是唯一状态源**：业务组件、hooks、事件处理函数都在 Node。
- **浏览器不加载 React**：远程页只有一个原生 JS 文件，它接收快照和操作流，把操作应用到 DOM。
- **第二个渲染器不依赖浏览器**：`src/tui/` 是同一套 `snapshot` + `patch` 协议的终端 TUI 客户端，可与浏览器同时在线。
- **跨进程传的是操作，不是 HTML/截图**：`create` / `insert` / `update` / `remove`。
- **刷新靠快照**：新连接先收全量 `snapshot`，之后只收增量 `patch`。

这是一个教学 Demo，目标是让每条链路都短到可以读完；它不是生产级的远程渲染方案。

---

## 快速开始

要求 Node 20+。

```bash
npm install
npm start
```

`npm start` 会先执行一次 `npm run build:web`（M6 的 react-dom 对照页需要），再用 `tsx` 启动 Node 服务。

再开一个终端，启动第二个渲染器（终端 TUI）：

```bash
npm run tui
```

打开：

| 地址 / 命令 | 渲染方 | 用途 |
| --- | --- | --- |
| <http://127.0.0.1:8787/> | Node 里的 React + 自定义 hostConfig | 主演示：远程渲染到浏览器 DOM |
| <http://127.0.0.1:8787/web> | 浏览器里的 react-dom | M6 对照：同一份 `app.tsx` 换渲染器 |
| `npm run tui` | Node 里的同一套 ops + 终端 TUI 解释器 | 第二个渲染器：不依赖浏览器 |

其他命令：

```bash
npm run start:remote   # 跳过 build:web，只启动远程页
npm run tui            # 终端 TUI，连接现有 /ws（先启动服务端）
npm run tui:once       # 非交互：连接后输出一帧，便于断言
npm run tui:frames     # 非交互：输出 snapshot 帧 + 1 个 patch 帧
npm run build:web      # 只构建 /web 用的 bundle
npm run typecheck      # tsc --noEmit
```

注意：

- 没有 watcher。改 `src/app.tsx` 后需要重启 Node；改 `src/webui/interpreter.js` 后刷新浏览器即可。
- 端口固定 `127.0.0.1:8787`。被占用时先停掉旧进程。
- 日志：Node 看终端；浏览器看 DevTools Console。浏览器端还暴露了 `window.__logs`、`window.__nodes`、`window.__props`、`window.__identity(id)` 方便检查。
- `/web` 依赖 `src/webui/web-bundle.js`。只用 `npm run start:remote` 且从未构建时，这个页面会 500。
- TUI 建议在 Windows Terminal / 现代终端里运行；旧 conhost 不支持某些 VT 序列时可加 `--no-alt-screen`。`Ctrl+C` 或 `Esc` 退出并恢复终端。

---

## 数据流向

```text
┌────────────────────────────── Node 进程（状态源） ──────────────────────────────┐
│                                                                                 │
│  src/app.tsx                                                                    │
│      │  React.createElement / hooks / setState                                  │
│      ▼                                                                          │
│  react-reconciler 0.29.0                                                         │
│      │  调用 hostConfig                                                          │
│      ▼                                                                          │
│  hostConfig.ts                                                                  │
│      ├── 维护“假节点树”（id / type / props / children，无渲染行为）              │
│      └── 在 render/commit 阶段记录 create / insert / update / remove             │
│                              │                                                  │
│                              ▼                                                  │
│                    resetAfterCommit：把本批 ops 一次 flush                       │
│                              │                                                  │
│                              ▼                                                  │
│              ws://127.0.0.1:8787/ws   ── snapshot（连接时全量）                 │
│                                        └─ patch（每次 commit 增量）              │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────── 浏览器（无 React） ────────────────────────────────┐
│                                                                                 │
│  interpreter.js                                                                 │
│      ├── snapshot → 清空 root → 递归建 DOM（id → DOM 的 Map）                    │
│      ├── patch    → 依次应用 create / insert / update / remove                   │
│      └── 原生事件委托（click / mousedown / input）                               │
│                              │                                                  │
│                              ▼                                                  │
│                   { kind: 'event', id, name, payload }                          │
│                              │                                                  │
│                              ▼                                                  │
│           Node 的 runHandler → 找到宿主节点 props[name] → setState              │
│                              │                                                  │
│                              └── 触发下一次 commit → 新一轮 patch → 回到浏览器   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

一句话：**React 的协调结果在 Node 被翻译成小操作，浏览器只负责“照操作改 DOM”；事件反向流回 Node，状态变更再变成新的操作。**

第二个目标复用同一条下半段：`src/tui/` 的独立 WS 客户端把同一批 `snapshot` / `patch` 应用到 `TargetTree`，再布局成字符网格输出到终端；键盘事件按同样的 `{ kind: 'event', id, name, payload }` 格式回传 Node。服务端和 `hostConfig` 不需要为 TUI 做任何修改。

---

## 目录结构

```text
.
├─ src/
│  ├─ app.tsx                 # 唯一的业务 App，多个渲染器共用
│  ├─ widgets.tsx             # 远程控件：只 createElement('Box' | 'Text' | ...)
│  ├─ widgets.dom.tsx         # M6：同名控件的 react-dom 实现
│  ├─ web-render.tsx          # M6：createRoot(...).render(<App />)
│  ├─ node-render.ts          # HTTP 静态服务 + WebSocket + 启动渲染
│  ├─ renderer/
│  │  ├─ hostConfig.ts        # 假节点树 + 操作录制（每个函数都有一行注释）
│  │  ├─ ops.ts               # 4 种操作类型 + clean()/cleanProps()
│  │  └─ snapshot.ts          # 假节点树 → 全量快照
│  ├─ webui/
│  │  ├─ index.html           # 远程页 /，只加载 interpreter.js
│  │  ├─ interpreter.js       # 手写解释器：快照 + 4 种操作 + 事件回传
│  │  ├─ web.html             # 对照页 /web
│  │  └─ web-bundle.js        # esbuild 产物，已 gitignore
│  └─ tui/                    # 第二个渲染器：终端 TUI（不依赖浏览器）
│     ├─ protocol.ts          # 消息类型，type-only 复用 ops.ts / snapshot.ts
│     ├─ target.ts            # TargetTree：镜像快照并应用 4 种操作
│     ├─ width.ts             # CJK/emoji 显示宽度、码点与截断工具
│     ├─ screen.ts            # Cell Grid、ANSI 序列化、颜色降级
│     ├─ layout.ts            # Box/Border/Text/Button/Input 的测量与排布
│     ├─ paint.ts             # 栅格化、焦点、Input 光标、状态栏
│     ├─ keys.ts              # readline keypress -> 终端动作
│     ├─ session.ts           # WS 连接、焦点/编辑状态、渲染调度、终端生命周期
│     └─ main.ts              # CLI 入口：--once / --frames / --color 等
├─ scripts/
│  └─ build-web.mjs           # 只给 M6 用的一次性构建
├─ docs/
│  └─ m5-naive-log.md         # M5 直写法实验的完整日志
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

## 原理点 1：可插拔渲染器

`src/app.tsx` 只 import `./widgets`，从不 import `react-dom` 或 `react-reconciler`。

- **远程渲染**：`widgets.tsx` 把 `<Box>` 变成 `React.createElement('Box', props)`。hostConfig 的 `createInstance` 收到宿主类型字符串 `"Box"`，创建假节点，发 `create` 操作。浏览器把 `"Box"` 映射成 `<div>`。
- **终端 TUI**：复用同一个 hostConfig 和同一批操作流；`src/tui/` 把 `"Box"` 排成字符网格里的一个区域，`"Button"` 渲染成 `[label]`。它连的是同一个 `/ws`，不加载 React。
- **react-dom 渲染**：`scripts/build-web.mjs` 用 esbuild 插件，只在 `app.tsx` 里把 `./widgets` 别名到 `widgets.dom.tsx`，后者把同名控件实现为真正的 `<div>` / `<span>` / `<button>` / `<input>`。

因此同一份业务代码现在有三个目标：

```text
src/app.tsx  ──┬── Node: widgets.tsx     → 自定义 hostConfig → 操作流 → interpreter.js（DOM）
               ├── Node: 同一份操作流     → 终端 TUI 客户端 → TargetTree → ANSI
               └── 浏览器: widgets.dom.tsx → react-dom        → 原生 DOM
```

`app.tsx` 从未被修改，M6 前后 SHA-256 都是：

```text
e302cc77c26235230ea89bdb3c1bfe11eb277265b71ad540b1930e17f1224cd0
```

`/web` 页面里没有 `Box` / `Text` / `Border` 这类自定义标签，只有普通 DOM。

---

## 原理点 2：操作流

hostConfig 不渲染，只做两件事：

1. 维护一棵和 React 树同构的**假节点树**；
2. 把 React 的每次结构/属性变化翻译成操作，记进 `currentOps`。

`resetAfterCommit` 把本批操作统一交给 `onCommit`，Node 通过 WebSocket 发给所有客户端。渲染阶段产生的操作不会逐条发送，而是攒到 commit 后一批发走。

### 操作类型 → 浏览器行为

| 操作 | 什么时候产生 | 字段 | 浏览器端做什么 |
| --- | --- | --- | --- |
| `create` | `createInstance` / `createTextInstance`，render 阶段 | `id, type, props` | 创建 DOM 节点或文本节点；写入 `id → DOM`、`id → props` 映射；应用样式。**此时节点是游离的，不插入文档。** |
| `insert` | `appendInitialChild` / `appendChild` / `insertBefore` / 容器版本 | `parent, child, index` | 若子节点已有父节点先 detach；按 Node 给的下标 `insertBefore`。新子树在这一步才真正可见，也支持移动已有节点。 |
| `update` | `commitUpdate` / `commitTextUpdate`，commit mutation 阶段 | `id, patch` | 把 patch 合并进本地 props；文本节点改 `nodeValue`；元素按类型重设样式；`null` 表示删除该属性。**DOM 引用不变。** |
| `remove` | `removeChild` / `removeChildFromContainer` / `clearContainer` | `id` | 从该 DOM 节点向下递归，删除整棵子树以及所有 id 映射；只传子树根的 id。 |

一次 patch 的形状：

```json
{
  "kind": "patch",
  "ops": [
    { "op": "create", "id": 7, "type": "Button", "props": { "handled": true, "__events": ["onClick", "onMouseDown"] } },
    { "op": "insert", "parent": 6, "child": 7, "index": 2 },
    { "op": "update", "id": 3, "patch": { "backgroundColor": "#ffe08a" } },
    { "op": "remove", "id": 21 }
  ]
}
```

几个容易踩的实现细节：

- `appendInitialChild` **也要发 `insert`**。`create` 不携带父子关系，新增子树的内部结构必须靠这些 `insert` 在浏览器里拼起来；父节点此时游离，可以先组装，等 commit 时再整体挂到已挂载的父节点上。
- 文本是独立的 `#text` 节点。`commitTextUpdate` 发 `update`，浏览器只改 `nodeValue`，不重建节点。
- 父宿主的 `children` 变化会让 React 对父节点调用 `prepareUpdate`。`diffProps` 必须排除 `children`，否则每次子节点增删都会多一条无意义的父节点 `update`。
- `prepareUpdate` 即使只有事件函数变化也要返回 truthy（本 Demo 返回 `{}`），否则 `commitUpdate` 不会执行，Node 侧保存的事件处理器就会过期。
- 事件函数不过线：`cleanProps` 把它们折叠成 `props.__events` 的名字数组，浏览器只据此决定“哪些节点要监听什么事件”。

---

## 原理点 3：快照 + 增量

- **连接时**：Node 发送 `{ kind: 'snapshot', tree }`，内容是完整的假节点树（文本也包含在内）。
- **浏览器收到 snapshot**：清空 `#root` 和所有 Map，递归重建整棵 DOM。不是插入 HTML 字符串。
- **之后**：每次 Node commit 发送一批 `{ kind: 'patch', ops }`。
- **没有客户端时**：本批 ops 直接丢弃，不排队；下一个客户端连接时拿当前快照即可。
- **刷新页面**：旧连接断开，新连接建立，浏览器从 Node 当前状态重建。`count` 和输入框内容都还在，因为状态不在浏览器里。

实测刷新时 Node 日志：

```text
[node] 客户端断开，剩余 0
[node] 新客户端连接，发送快照
[node] 快照已发送，节点数 34，客户端数 1
```

这暴露了一个生产方案必须解决的问题：快照和 patch 之间没有版本号/序号，断线期间也没有重放。本 Demo 靠“新连接总是拿全量快照”回避了这些。

---

## 原理点 4：同步返回的坑（M5）

### 直写法：在原生事件里等 Node 回答

浏览器要决定 mousedown 是否继续冒泡给父容器。按钮的 `onMouseDown` 在 Node 里，于是浏览器发 `syncAsk`，然后**忙等 400ms**，等 Node 回 `syncAnswer`。

实测结果（完整日志见 [`docs/m5-naive-log.md`](docs/m5-naive-log.md)）：

- `page.click()` 耗时 **437ms**，其中 400ms 浏览器主线程被占住，页面无法响应/重绘。
- Node 几毫秒内就回了 `true`，但浏览器的 `message` 事件也要在主线程派发；主线程忙等时回包只能排队，直到超时后才被处理到（`t=796ms` 才收到 `t=393ms` 问的回答）。
- 浏览器把超时当成“未处理”，把 mousedown 路由给了父容器，父容器错误高亮 `rgb(255, 224, 138)`。按钮明明声明了已处理。
- 改 Promise：冒泡决定被异步化，原生事件早已结束，时机全变。
- 阻塞 Node 等浏览器：Node 的事件循环停了，WS 回包进不来，直接死锁。
- `Atomics.wait`：浏览器主线程不允许；放 Worker 也救不了，因为 WS message 仍在被阻塞的主线程上。

### 修复：把“返回值”提前声明成属性

- `Button` 增加布尔属性 `handled`，Node 在 `create` / `update` 的 props 里把它序列化下来。
- 浏览器的 mousedown 分发器**本地**读 `props.handled`：
  - `true`：异步发送按钮自己的 `onMouseDown` 事件（fire-and-forget），然后停止向父容器路由；
  - `false / undefined`：发送按钮事件，继续路由到父容器。
- Node 只负责异步收事件、改状态；父容器高亮由 Node 状态驱动。

运行时代码里不再有任何同步等待：

```text
$ grep -rn "syncAsk\|syncAnswer" src
(no output)
```

实测：handled 按钮点击后父容器保持 `rgb(243, 244, 246)`；普通按钮点击后出现 `rgb(255, 224, 138)` 高亮再恢复。

### 150 字以内小结

> 浏览器若要在同一个原生事件里根据返回值决定是否冒泡、preventDefault 或播放反馈，就必须把依据提前声明成属性，让浏览器本地裁决；跨进程同步等不到。若只是事后改状态、再推一次界面，用异步事件即可，多等一帧可接受。

### 关于第 4 种消息 `syncAsk`

题目里的 4 种消息是 `snapshot` / `patch` / `event` / `syncAsk`。`syncAsk` 只在 M5 直写实验里存在，而且为了让 Node 能回话，还被迫多出第 5 种 `syncAnswer`。

这本身就是实验结论：**同步语义无法用“发一条消息再等回包”在浏览器主线程上实现**。修复后，`syncAsk` / `syncAnswer` 从运行时代码中删除，只保留在实验记录里；最终运行时只有前 3 种消息。这不是遗漏，而是 M5 要求的修复结果。

---

## 消息协议与 `clean()`

最终运行时只有 3 种消息：

| kind | 方向 | 内容 |
| --- | --- | --- |
| `snapshot` | Node → 浏览器 | 建立连接时的全量假节点树 |
| `patch` | Node → 浏览器 | 一次 commit 的 `Op[]` |
| `event` | 浏览器 → Node | `{ id, name, payload }`，`name` 是 `onClick` / `onChange` / `onMouseDown` |

所有跨进程数据都先过 `clean()` / `cleanProps()`（`src/renderer/ops.ts`）：

| 规则 | 原因 |
| --- | --- |
| 函数不传输；`onXxx` 折叠为 `props.__events` 名字数组 | JSON 不能携带函数；浏览器只需要知道要监听哪些事件，真正函数留在 Node。 |
| `undefined` / `symbol` / `bigint` / `NaN` / `Infinity` 丢弃 | 前三个不是合法 JSON，后两个 `JSON.stringify` 会变成 `null`，会在两端造成形状不一致。 |
| 数字统一保留 2 位小数，`-0` 归一为 `0` | 避免浮点尾数导致“看起来没变却一直发 update”，也让两端比较稳定。 |
| 颜色键（`color` / `backgroundColor` 等）统一成 `#RRGGBB` | `#abc`、`rgb()`、`#RRGGBB` 在浏览器端要能按同一个值比较；带 alpha 的写法在 Demo 中丢弃 alpha。命名色原样保留。 |
| 丢弃 React element、非普通对象、循环引用 | 这些不是可序列化的业务数据，且可能带内部字段/环。 |
| 数组中被丢弃的项填 `null` | 保持下标不变，避免元素错位。 |
| `children` 不放进 props | 父子关系由节点树的 `children` 和 `insert` 操作表达；`children` 里可能有 React element，会递归爆炸。 |
| 浏览器发来的 event payload 也过 `clean()` | 不信任对面传来的任何数据。 |

`clean()` 不是“顺手做的格式化”，而是跨进程协议的一部分：它保证同一份 props 在 Node 和浏览器两端的形状、精度、颜色表示是一致的。

---

## hostConfig 实现清单

`src/renderer/hostConfig.ts` 中每个函数都有一行注释说明 React 何时调用。按用途分组：

| 分组 | 函数 |
| --- | --- |
| 创建 / 文本 | `createInstance`、`createTextInstance`、`appendInitialChild`、`finalizeInitialChildren`、`shouldSetTextContent` |
| 更新 | `prepareUpdate`、`commitUpdate`、`commitTextUpdate` |
| 提交 | `prepareForCommit`、`resetAfterCommit` |
| 已挂载结构变更 | `appendChild`、`insertBefore`、`appendChildToContainer`、`insertInContainerBefore`、`removeChild`、`removeChildFromContainer` |
| 容器 / 删除 | `clearContainer`、`detachDeletedInstance` |
| 上下文 / 实例 | `getRootHostContext`、`getChildHostContext`、`getPublicInstance`、`getInstanceFromNode` |
| 本 Demo 不使用 | `commitMount`、`resetTextContent`、`hideInstance`、`hideTextInstance`、`unhideInstance`、`unhideTextInstance`、`preparePortalMount`、`prepareScopeUpdate`、`getInstanceFromScope`、`beforeActiveInstanceBlur`、`afterActiveInstanceBlur` |
| 调度 / 优先级 | `getCurrentEventPriority`、`scheduleTimeout`、`cancelTimeout` |

另有配置项：`supportsMutation: true`、`supportsPersistence: false`、`supportsHydration: false`、`isPrimaryRenderer: false`、`noTimeout: -1`。

渲染入口：

```ts
reconciler.createContainer(root, 0 /* LegacyRoot */, null, false, null, '', onRecoverableError, null);
reconciler.updateContainer(<App />, fiberRoot, null, null);
```

LegacyRoot 让 `updateContainer` 和 WS 回调里的 `setState` 都同步提交，Demo 更容易观察。代价见“已知问题”。

---

## 验收：M1–M7 怎么观察

以下是一次实测的代表值；节点 id、commit 编号、`count` 会随启动时长变化。

### M1：管道打通，快照建 DOM

```text
[node] 渲染 App...
[node] 初始渲染完成，假节点数 34
[node] HTTP/WS 监听 http://127.0.0.1:8787
[node] 新客户端连接，发送快照
[node] 快照已发送，节点数 34，客户端数 1
```

浏览器：

```text
[web] WS 已连接
[web] 收到 snapshot
[web] 快照重建完成，节点数 34
```

打开 `/` 能看到完整界面。初始 commit 时没有客户端，`create` / `insert` 会被丢弃，这是预期行为：新客户端靠快照重建。

### M2：增量更新与 DOM 身份

`count` 每秒自增，Node 只发 `update`：

```text
[web] 收到 patch（Node 的增量操作） 1 条 update
[web] update #text #4 -> count: 31
```

取 DOM 身份：

```js
window.__identity(4)
// { id: 4, element: #text, sameNode: true, connected: true }
```

实测结果：

```json
{
  "beforeValue": "30",
  "afterValue": "31",
  "textSameNode": true,
  "spanSameNode": true,
  "originSame": true,
  "connected": true
}
```

文本变了，DOM 节点没被替换。

### M3：事件回传（点击 / 输入）

点击 `+1` 的完整链路：

```text
[web] 浏览器端发生点击 #7
[web] 发送事件 onClick #7
[node] Node 端收到事件 Button#7 onClick {}
[node] Node 端状态变更：count + 1
[node] commit #N，1 条 ops [update]
[web] 收到 patch（Node 的增量操作） 1 条 update
[web] update #text #... -> count: 32
```

输入框：

```text
[web] 浏览器端发生 input #12 "hello-remote"
[web] 发送事件 onChange #12
[node] Node 端收到事件 Input#12 onChange { value: 'hello-remote' }
[web] update Input #12 同一 DOM 节点: true
```

输入是受控的：浏览器把值发回 Node，Node `setState`，再靠 `update` 把值推回来。

动态子树（`显示详情` / `隐藏详情`）：

```text
打开：节点数 34 → 37，7 条 ops [create,create,insert,create,insert,update,insert]
关闭：2 条 ops [remove,update]，浏览器删除 3 个节点
```

### M4：刷新靠快照重建

把 `count` 放到 37、输入框填 `hello-remote`，刷新 `/`：

- `count` 仍是 37（刷新期间可能继续自增），输入框仍是 `hello-remote`。
- Node 日志出现 `客户端断开` → `新客户端连接，发送快照`。
- 浏览器日志出现 `收到 snapshot` → `快照重建完成`。

状态从未存进浏览器，刷新只是重新拿了一次 Node 的当前状态。

### M5：同步返回的坑

- 直写实验的日志、耗时、错误高亮、为什么 Promise/Atomics 都不行：见 [`docs/m5-naive-log.md`](docs/m5-naive-log.md)。
- 修复后：
  - handled 按钮点击后，父 Border 背景始终 `rgb(243, 244, 246)`；
  - 普通按钮点击后，父 Border 短暂出现 `rgb(255, 224, 138)`，320ms 后恢复；
  - `grep -rn "syncAsk\|syncAnswer" src` 无输出。

### M6：同一份 App，换渲染器

`/web` 实测：

```text
customTags: 0
按钮文字: ["+1", "显示详情", "handled 按钮", "普通按钮"]
input placeholder: "type here"
```

- 远程页与 `/web` 的文本内容在把 `count: \d+` 归一后完全一致。
- `+1`、输入框、显示/隐藏详情都正常。
- M5 行为也一致：handled 按钮不触发父容器高亮，普通按钮触发。
- 页面无 `console.error` / `pageerror`。
- `/web` 没有自定义标签（`Box` / `Text` / `Border` 数量为 0）。

### M7：终端 TUI（第二个渲染器）

终端 A 启动服务端，终端 B 运行 `npm run tui`：

```text
node-render.ts terminal:
[node] 新客户端连接，发送快照
[node] 快照已发送，节点数 34，客户端数 1
```

TUI 应显示完整界面、圆角/方角 Border、CJK 文字和底部状态栏；`count` 每秒变化，状态栏显示 `ws:on | patch #N`。

同时打开浏览器 `http://127.0.0.1:8787/`：

- Node 日志客户端数变为 2；
- 任一端的操作都会让两端同步更新（同一个 reconciler、同一批 patch）。

交互检查：

- 焦点顺序：`+1` → `name` Input → `显示详情` → `handled 按钮` → `普通按钮`。
- 聚焦 `+1` 按 Enter：两端 count 都增加；TUI 状态栏 patch 编号增加。
- 聚焦 `handled 按钮` 按 Enter：Node 日志只有它自己的 `onMouseDown` 和 `onClick`，父 Border 不高亮。
- 聚焦 `普通按钮` 按 Enter：Node 日志有按钮和父 Border 的 `onMouseDown`，Border 短暂高亮。
- 聚焦 Input 输入中文/英文、退格、左右移动：Node 日志收到 `onChange`，浏览器输入框同步；连续快输入时 TUI 本地 draft 不被滞后 patch 吞掉。
- 调整终端大小：布局重排，不花屏。
- `Ctrl+C` 退出后终端恢复（光标可见、回到原屏幕）；重新运行 `npm run tui`，靠 snapshot 恢复 count 和 name。

非交互冒烟：

```bash
npm run tui:once | grep -E "Remote React Demo|count:|显示详情"
npm run tui:frames
```

`tui:once` 应输出一帧纯文本；`tui:frames` 输出两帧，`count` 值不同，状态栏分别是 `patch #0` 和 `patch #1`。

---

## 第二个渲染器：终端 TUI

`src/tui/` 是第二个渲染目标：不加载 React、不依赖浏览器，作为独立 WS 客户端连接 `ws://127.0.0.1:8787/ws`。它消费的仍然是 Node 里唯一 reconciler 产生的 `snapshot` + `patch`，因此：

- Node 状态只有一份；TUI 和浏览器同时在线时看到的是同一份状态。
- 服务端、`hostConfig`、协议都没有为 TUI 改动。
- 新连接/断线重连仍然靠全量 snapshot 恢复。

```text
React (Node)
  → hostConfig → { snapshot, patch } ─┬→ 浏览器 interpreter → DOM
                                      └→ TUI TargetTree → 布局 → Cell Grid → ANSI
TUI 键盘 → { kind:'event', id, name, payload } → runHandler → setState → 新 patch
```

### 终端侧链路

1. `target.ts` 的 `TargetTree` 与 `interpreter.js` 等价地应用操作：`insert` 先 detach 再按 index 插入，`remove` 只带子树根 id 所以必须递归删除，`update` 用 `null` 删除属性。
2. `layout.ts` 自底向上测量、自顶向下排布出 `LayoutBox`；`paint.ts` 把盒子画到 `screen.ts` 的 Cell Grid，再序列化成 ANSI。
3. `session.ts` 负责 WS 连接/重连、焦点与编辑状态、事件发送、16ms 合并重绘、alternate screen / raw mode / resize / 退出恢复。
4. `keys.ts` 把 readline keypress 归一化成动作；`main.ts` 解析 CLI 并处理 `--once` / `--frames`。

### 布局近似规则

| 规则 | 说明 |
| --- | --- |
| 像素 → 字符格 | `max(1, round(px / 16))`；当前 App 的 gap 8/12、padding 8/12 都映射为 1 格 |
| Box | 支持 `row` / `column`、`gap`、`align`、`justify`；`stretch` 只做简单的交叉轴填充 |
| Border | 用 1 格外框近似浏览器里无边框的 div；`radius > 0` 用圆角 `╭╮╰╯`，否则 `┌┐└┘`；背景色填充整个区域 |
| Text | 单行不换行；`size >= 18` 加 bold，`size <= 12` 用 dim（终端无法改字号） |
| Button | 渲染为 `[label]`；聚焦时用高亮背景和加粗文字 |
| Input | 宽度 clamp 到 12~40 列；聚焦编辑时水平滚动并用反显单元格画光标 |
| CJK | 按 code point 计算显示宽度；宽字符占 2 格，组合字符附加到前一格 |
| 溢出 | v1 不换行、不滚动；超宽截断，超高由 Grid 裁剪 |
| 颜色 | 24-bit / 256 / 16 / none；`auto` 根据 `COLORTERM`/`TERM` 选择 |

### 键盘

| 按键 | 行为 |
| --- | --- |
| `Tab` / `Shift+Tab` | 在 `Button` / `Input` 之间循环切换焦点 |
| `Up` / `Down` | 切换焦点（Input 内不用于移动光标） |
| `Enter` / `Space` | 触发焦点 Button；Input 编辑时 `Enter` 移到下一个控件，`Space` 插入空格 |
| `←` / `→` / `Home` / `End` | 移动 Input 光标 |
| `Backspace` / `Delete` | 删除 Input 字符 |
| `Ctrl+C` / `Esc` | 退出并恢复终端 |

### Button 事件顺序与 `handled`

键盘激活模拟浏览器里“按下再点击”的顺序：

1. 遍历 `chain(buttonId, 'onMouseDown')`，逐个发送；每发一个后检查该节点的 `props.handled === true`，为 true 则停止向祖先冒泡。
2. 再遍历 `chain(buttonId, 'onClick')`，逐个发送 `onClick`，**不检查 handled**（与浏览器 click 行为一致）。

因此：

- `handled 按钮` 按 Enter：只发自己的 `onMouseDown`，父 Border 不收到，不会高亮。
- `普通按钮` 按 Enter：按钮和父 Border 都会收到 `onMouseDown`，父 Border 短暂高亮约 320ms。
- 两个按钮的 `onClick` 都会触发；`+1` 也会让两个客户端同时增加计数。

### Input 受控回流

- 进入 Input 焦点时，本地 `draft` 从服务端 `value` 初始化，光标在末尾。
- 每次编辑立即重绘，并向 `chain(inputId, 'onChange')` 发送 `{ value: draft }`。
- 服务端 patch 回来时：
  - 等于当前 draft：确认，保持光标；
  - 等于某个尚未确认的已发送值：判定为滞后的回显，保留本地更长的 draft（避免快输入时吞字）；
  - 其他：视为外部修改，采用服务端值并把光标移到末尾。
- 焦点移到别的控件、或 Input 被 remove 时，编辑态清空。

### 非交互模式

```bash
npm run tui:once     # snapshot 一帧，stdout 纯文本
npm run tui:frames   # snapshot 帧 + 1 个 patch 帧（默认 count 会变化）
```

- 非交互模式的 stdout 只有帧内容，调试日志写 stderr，便于管道/grep/断言。
- `--width` / `--height` 指定虚拟终端尺寸；`--no-color` 完全关闭 ANSI 样式。
- `--frames N` 的计数规则：snapshot 是第 1 帧，之后每个 patch 一帧。
- 非交互模式不会进入 raw mode / alternate screen，也不自动重连。

---

## 与真正生产方案的差距

1. **没有布局引擎和测量**：浏览器自己跑 CSS flex 布局；Node 不知道任何元素的实际尺寸、换行结果、滚动高度。真实方案（如 React Native / 游戏 UI）需要在宿主侧做 measure，把约束和尺寸回传，才能支持文本换行、百分比、绝对定位、虚拟列表。
2. **没有字体度量**：文本宽度、行高、省略号、富文本都依赖字体；Node 侧无法预测浏览器用哪套字体渲染，跨平台会出现布局差异。生产方案要固定字体资源并在宿主侧测量。
3. **没有滚动 / 裁剪 / 命中测试 / 层级**：本 Demo 只有普通文档流。滚动容器、滚动位置同步、`overflow: hidden`、z-index、鼠标命中测试都没有。真实远程 UI 需要把这部分状态纳入协议。
4. **事件模型太薄**：只做了 `click` / `mousedown` / `input` 三个委托事件；没有 focus/blur、键盘、滚轮、右键菜单、拖放、pointer capture、选择、输入法（IME）组合、无障碍。Input 的光标在每次受控更新后会跳到末尾，也是这个缺口的直接表现。
5. **没有可靠性层**：没有消息序号、确认、重连、断线重放、快照版本、多客户端一致性。刷新能恢复只是因为“新连接发全量快照”；断线期间的更新会永久丢失。
6. **没有背压和性能优化**：一次 commit 全量发一个 JSON patch，没有合并、节流、压缩、二进制编码、增量 diff 压缩；大树/长列表会越来越慢。也没有 React 并发渲染下的优先级/中断处理（本 Demo 用 LegacyRoot 同步提交回避了）。
7. **同步几何读取不可用**：组件在 Node 里无法同步拿到浏览器里的 `getBoundingClientRect`、滚动位置、焦点状态。生产方案必须像 M5 的 `handled` 一样，把同步依赖改成声明式属性 + 异步测量，或者把这类组件整体搬到宿主侧。
8. **宿主集成是“假”的**：真实目标（UE/UMG、Slate、原生窗口）有平台线程模型、原生控件生命周期、输入法、GPU 合成、字体渲染。生产传输也不会是明文 JSON over WS，而会是引擎 RPC、共享内存或专用通道。
9. **安全与健壮性**：没有认证、消息 schema 校验、大小限制、速率限制、错误恢复、恶意客户端防护。浏览器的 `event` payload 虽然过了 `clean()`，但没有字段级白名单。
10. **没有完整的样式/主题/响应式能力**：只有 6 个控件的少量属性映射，没有主题、媒体查询、动画、伪类、阴影、变换、渐变。真实方案要么把样式限制成可控的子集（像 React Native），要么把样式计算放到宿主侧。
11. **没有 hydrate / 错误边界 / Suspense 降级**：快照总是整棵重建；没有部分水合、错误 UI、加载占位。`hideInstance` 等 Suspense 钩子在本 Demo 中是空实现。

---

## 已知问题与有意不做

- **Input 光标会跳到末尾（浏览器）**：受控输入每次 patch 回来都重设 `value`。按要求不做光标保持；TUI 自己维护光标，不受此影响。
- **多客户端是广播**：所有客户端收到同一份 patch；没有按客户端区分的状态。TUI 的焦点/编辑态是本地状态，Input 并发编辑最后写入者获胜。
- **无重连（浏览器）**：浏览器 WS 断开后不会自动重连；刷新建立新连接并重新拿快照。TUI 交互模式做了 500ms 起步、最大 5s 的指数退避重连，重连后同样靠 snapshot 恢复。
- **无客户端时 ops 丢弃**：不排队、不重放；这是有意简化。
- **LegacyRoot 同步提交**：便于观察日志，但不是并发安全的完整实现。
- **ops 在 render 阶段产生**：如果一次并发渲染被 React 放弃，已记录的 create/insert 可能残留到下一批。本 Demo 的同步根不会触发，但生产实现要按 commit 范围隔离。
- **`clean()` 有损**：alpha 被丢弃，命名色原样保留，非普通对象被丢弃；这是为了 Demo 可读性，不是通用序列化器。
- **未知宿主类型静默变 `<div>`**：`interpreter.js` 的 `TAGS[type] || 'div'` 是容错，不是正式行为；TUI 把它当透明 column 容器。
- **`handled` 只影响 mousedown 路由**：click 仍会沿祖先链发送给所有带 `onClick` 的节点；Demo 里父容器没有 `onClick`，所以没暴露。
- **TUI 布局是近似**：`px → 字符格` 用固定 16px/格；Border 用 1 格外框近似浏览器里无边框的 div；`align="stretch"` 只做简单填充；不支持换行、滚动、圆角像素、阴影。
- **TUI 的 CJK/emoji 宽度是近似 wcwidth**：组合字符和 ZWJ 序列可能有偏差；不支持输入法组合预览，只处理提交后的文本。
- **TUI 依赖终端 VT 支持**：旧 conhost 可能不支持 alternate screen / 24-bit 颜色；可用 `--no-alt-screen`、`--color=256/16/none` 降级。被 SIGKILL 时来不及恢复终端，可用 `reset` 命令修复。

---

## 版本说明

最终依赖：

```json
"react": "18.2.0",
"react-dom": "18.2.0",
"react-reconciler": "0.29.0"
```

最初计划的是 `react-reconciler@0.29.2`。实测 npm 会报 `ERESOLVE`：0.29.2 的 peer dependency 要求 `react@^18.3.1`，而 18.2.0 不满足。`0.29.0` 的 peer 是 `react@^18.2.0`，因此最终采用 **React 18.2.0 + react-reconciler 0.29.0**。

本 Demo 用到的 hostConfig API（`prepareUpdate` 返回 updatePayload、`commitUpdate` 接收 updatePayload、LegacyRoot 等）在 0.29.0 和 0.29.2 中一致。若要用 0.29.2，请把 React 一起升到 18.3.1。

React 19 的 host config 签名不同（例如 `commitUpdate` 不再接收 updatePayload），不要混用。
