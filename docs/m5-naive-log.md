# M5 直写法实验记录：跨进程“同步返回”为什么给不出来

## 直写法

浏览器在原生 `mousedown` 里要决定：按钮的 `onMouseDown` 如果返回 `true`，
就不再把这个事件路由给父容器。但按钮的处理函数在 Node 里，于是浏览器发：

```json
{ "kind": "syncAsk", "id": 20, "question": "Handled?" }
```

然后**忙等 400ms**，指望拿到 Node 的回答。Node 收到后立刻执行
`onMouseDown` 并回 `{ kind: "syncAnswer", id: 20, value: true }`。

注意：这里临时多出了第 5 种消息 `syncAnswer`。原因很直白——`syncAsk`
必须有一个回包才能表达“同步问一句”。这也说明协议里那 4 种消息本身
并不足以做同步 RPC；修复后 `syncAsk` / `syncAnswer` 从运行时代码中全部删除。

## 实测浏览器日志

```text
t=393ms  [web] 浏览器端发生 mousedown #20
t=393ms  [web] 同步问 Node：Handled? #20 （忙等 400ms）
t=793ms  [web] 同步等待超时 400ms ；把这次 mousedown 当成未处理
t=793ms  [web] 冒泡到父容器的 mousedown #30
t=794ms  [web] 发送事件 onMouseDown #30
t=795ms  [web] 浏览器端发生点击 #20
t=795ms  [web] 发送事件 onClick #20
t=796ms  [web] 收到 syncAnswer #20 value= true （忙等期间 message 事件无法派发，现在才处理到）
t=796ms  [web] 收到 patch（Node 的增量操作） 1 条 update
```

## 实测 Node 日志

```text
[node] Node 端收到事件 Button#20 onMouseDown {}
[node] Button onMouseDown → true（已处理）
[node] onMouseDown 返回值 true
[node] syncAsk 回答 Handled? = true （浏览器此时多半收不到）
[node] Node 端收到事件 Border#30 onMouseDown {}
[node] 父容器 onMouseDown → 高亮
[node] onMouseDown 返回值 undefined
```

## 实际现象

1. **点击延迟 437ms**：`page.click()` 从按下到返回约 437ms，其中 400ms 是
   浏览器主线程忙等，页面在这段时间里无法响应/重绘——就是“UI 卡顿”。
2. **回答其实早就到了**：Node 在几毫秒内就执行完 `onMouseDown` 并发出
   `syncAnswer`。但浏览器的 `message` 事件也要在主线程派发；主线程正在
   忙等，所以这个回包只能排队，直到 793ms 超时之后才被处理到。
3. **父容器错误高亮**：浏览器把超时当成“未处理”，把 mousedown 路由给了
   父容器，Node 的父容器处理器执行并高亮。按钮明明是 `handled=true`，
   行为却是错的（`handledStillFlashed: true`，高亮色 `rgb(255, 224, 138)`）。
4. **改成 Promise 也不对**：如果让 `onMouseDown` 返回 Promise 并 `await`，
   父容器的路由决定就变成异步的，原生事件早已结束，冒泡/默认行为/高亮
   的时机全部改变，业务逻辑被“异步化”污染。
5. **阻塞 Node 事件循环更糟**：如果反过来让 Node 等浏览器，Node 的 WS
   服务器就无法处理回包，直接死锁。
6. **`Atomics.wait` 也不行**：浏览器主线程不允许阻塞式 `Atomics.wait`；
   即使放到 Worker，WS 的 message 仍在被阻塞的主线程上，回包还是进不来。

## 声明式修复

- `Button` 增加 `handled` 布尔属性，由 Node 在 create/update 时序列化下来。
- 浏览器的 mousedown 分发器**本地**读 `props.handled`：
  - `true`：发送按钮自己的 `onMouseDown` 事件（异步、fire-and-forget），
    然后停止向父容器路由；
  - `false/undefined`：发送按钮事件，继续路由到父容器。
- Node 只负责异步接收事件、改状态；父容器高亮由 Node 状态驱动。
- 运行时代码里不再有任何 `syncAsk` / `syncAnswer` / 忙等：

```text
$ grep -rn "syncAsk\|syncAnswer" src
(no output)
```

修复后实测：handled 按钮点击后父容器背景保持 `rgb(243, 244, 246)`；
普通按钮点击后出现 `rgb(255, 224, 138)` 高亮，再恢复。行为与直写法
**应该**有的行为一致（handled 不冒泡）。

## 150 字以内小结

> 浏览器若要在同一个原生事件里根据返回值决定是否冒泡、preventDefault
> 或播放反馈，就必须把依据提前声明成属性，让浏览器本地裁决；跨进程同步
> 等不到。若只是事后改状态、再推一次界面，用异步事件即可，多等一帧可接受。
