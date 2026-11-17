import * as readline from 'node:readline';
import type { Key } from 'node:readline';
import type { ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from 'node:tty';
import { WebSocket, type RawData } from 'ws';
import type { Op } from '../renderer/ops';
import type { SnapshotNode } from '../renderer/snapshot';
import { mapKey } from './keys';
import { computeLayout, type UiState } from './layout';
import { paintLayout, paintStatusBar } from './paint';
import type { ClientEventMessage, ServerMessage } from './protocol';
import { Grid, type ColorMode } from './screen';
import { TargetTree } from './target';
import { codePointLength } from './width';

/**
 * 终端渲染会话：WS 客户端 + 焦点/编辑状态 + 渲染调度 + 终端生命周期。
 *
 * 它不是第二个 reconciler，只是 Node 里那一个 reconciler 的第二个
 * ops 消费端。服务端协议和浏览器客户端都不需要改动。
 */

export interface TuiOptions {
  url: string;
  width: number;
  height: number;
  color: ColorMode;
  interactive: boolean;
  altScreen: boolean;
  showStatus: boolean;
  /** null 表示交互模式；1 等价于 --once。 */
  frames: number | null;
  timeoutMs: number;
  reconnect: boolean;
  debug: boolean;
}

interface EditingState {
  inputId: number;
  draft: string;
  caret: number;
  /**
   * 已经发给 Node、但还没有被 patch 确认的值。
   * 连续快速输入时服务端回显的可能是更早的值，需要用历史判断“滞后回显”，
   * 不能只比较最后一次发送值，否则会把用户刚输入的字符吞掉。
   */
  sentValues: string[];
}

interface FrameCache {
  width: number;
  height: number;
  lines: string[];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class TuiSession {
  private readonly options: TuiOptions;
  private readonly tree = new TargetTree();

  private ws: WebSocket | null = null;
  private connected = false;
  private synced = false;
  private closed = false;

  private focusedId: number | null = null;
  private editing: EditingState | null = null;
  private patchCount = 0;
  private frameCount = 0;

  private lastFrame: FrameCache | null = null;
  private renderTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 500;

  private terminalActive = false;
  private lastNotice = '';
  private fatalMessage: string | null = null;

  private keypressHandler: ((sequence: string, key: Key) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private signalHandler: (() => void) | null = null;
  private errorHandler: ((error: unknown) => void) | null = null;
  private rejectionHandler: ((reason: unknown) => void) | null = null;

  constructor(options: TuiOptions) {
    this.options = options;
  }

  start(): void {
    if (this.options.interactive) this.setupTerminal();

    if (!this.options.interactive) {
      this.timeoutTimer = setTimeout(() => {
        this.error(`等待 snapshot/帧超时（${this.options.timeoutMs}ms）`);
        this.stop(1);
      }, this.options.timeoutMs);
    }

    this.connect();
    if (this.options.interactive) this.requestRender(true);
  }

  stop(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.teardownTerminal();

    try {
      this.ws?.close();
    } catch {
      // 忽略关闭时的异常
    }
    this.ws = null;
    this.connected = false;

    if (this.fatalMessage) {
      process.stderr.write(`[tui] ${this.fatalMessage}\n`);
    }

    if (this.options.interactive) {
      process.exit(code);
    } else {
      process.exitCode = code;
      // 给 stdout 一个 flush 的机会；unref 后不会阻止进程自然退出。
      const timer = setTimeout(() => process.exit(code), 1000);
      timer.unref();
    }
  }

  private connect(): void {
    if (this.closed) return;

    this.log(`连接 ${this.options.url}`);
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 500;
      this.log('WS 已连接');
      this.requestRender();
    });

    ws.on('message', (data: RawData) => this.handleRawMessage(data));

    ws.on('error', (error: Error) => {
      this.log(`WS 错误：${error.message}`);
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      this.log('WS 已断开');
      this.requestRender();

      if (this.closed) return;

      if (this.options.interactive && this.options.reconnect) {
        this.scheduleReconnect();
      } else if (!this.options.interactive) {
        this.error('WS 已断开（非交互模式不重连）');
        this.stop(1);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
    this.log(`${delay}ms 后重连`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleRawMessage(data: RawData): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      this.log('收到非法 JSON');
      return;
    }

    if (message.kind === 'snapshot') {
      this.applySnapshot(message.tree);
      return;
    }

    if (message.kind === 'patch') {
      this.applyPatch(message.ops);
      return;
    }

    const kind = (message as { kind?: unknown }).kind;
    this.log(`未知消息 kind: ${String(kind)}`);
  }

  private applySnapshot(snapshot: SnapshotNode): void {
    this.tree.applySnapshot(snapshot);
    this.synced = true;
    this.patchCount = 0;

    const focusables = this.tree.focusables();
    this.focusedId = focusables.length > 0 ? focusables[0] : null;
    this.editing = null;
    this.syncEditingWithFocus();

    this.log(`收到 snapshot，节点数 ${this.tree.nodes.size}`);
    this.requestRender(true);
  }

  private applyPatch(ops: Op[]): void {
    this.synced = true;

    const oldFocusables = this.tree.focusables();
    const oldFocusIndex =
      this.focusedId != null ? oldFocusables.indexOf(this.focusedId) : -1;
    const editingId = this.editing?.inputId ?? null;

    const stats = this.tree.applyOps(ops);
    this.patchCount += 1;

    const focusables = this.tree.focusables();
    if (this.focusedId == null || !focusables.includes(this.focusedId)) {
      if (focusables.length === 0) {
        this.focusedId = null;
      } else {
        const index = Math.min(Math.max(0, oldFocusIndex), focusables.length - 1);
        this.focusedId = focusables[index];
      }
    }

    if (editingId != null) {
      const node = this.tree.get(editingId);
      const valueUpdated = ops.some(
        (op) =>
          op.op === 'update' &&
          op.id === editingId &&
          Object.prototype.hasOwnProperty.call(op.patch, 'value'),
      );

      if (!node || this.focusedId !== editingId) {
        this.editing = null;
      } else if (valueUpdated) {
        this.reconcileEditing(String(node.props.value ?? ''));
      }
    }

    this.syncEditingWithFocus();
    this.log(
      `patch #${this.patchCount}: +${stats.created.length} ~${stats.updated.length} -${stats.removed.length}`,
    );
    this.requestRender();
  }

  private syncEditingWithFocus(): void {
    if (this.focusedId == null) {
      this.editing = null;
      return;
    }

    const node = this.tree.get(this.focusedId);
    if (!node || node.type !== 'Input') {
      this.editing = null;
      return;
    }

    if (!this.editing || this.editing.inputId !== this.focusedId) {
      const value = String(node.props.value ?? '');
      this.editing = {
        inputId: this.focusedId,
        draft: value,
        caret: codePointLength(value),
        sentValues: [],
      };
    }
  }

  /**
   * 服务端 value 回流时的合并策略：
   * - 等于当前 draft：确认，清空发送历史并保持光标；
   * - 等于某个尚未确认的发送值：是滞后的 patch 回显，本地已经输入更多，保留 draft；
   * - 其他：外部修改，采用服务端值。
   */
  private reconcileEditing(serverValue: string): void {
    const editing = this.editing;
    if (!editing) return;

    if (serverValue === editing.draft) {
      editing.sentValues = [];
      return;
    }

    if (editing.sentValues.includes(serverValue)) return;

    editing.draft = serverValue;
    editing.caret = codePointLength(serverValue);
    editing.sentValues = [];
  }

  private requestRender(forceFull = false): void {
    if (forceFull) this.lastFrame = null;
    if (this.closed) return;

    if (!this.options.interactive) {
      if (!this.synced || this.renderTimer) return;
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null;
        this.renderFrame();
      }, 0);
      return;
    }

    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderFrame();
    }, 16);
  }

  private renderFrame(): void {
    if (this.closed) return;
    if (!this.options.interactive && !this.synced) return;

    const terminal = process.stdout as TtyWriteStream;
    const width = Math.max(
      1,
      this.options.interactive ? (terminal.columns ?? 80) : this.options.width,
    );
    const height = Math.max(
      1,
      this.options.interactive ? (terminal.rows ?? 24) : this.options.height,
    );
    const contentHeight = Math.max(1, height - (this.options.showStatus ? 1 : 0));

    const ui: UiState = {
      focusId: this.focusedId,
      editingId: this.editing?.inputId ?? null,
      draft: this.editing?.draft ?? '',
      caret: this.editing?.caret ?? 0,
    };

    const layout = computeLayout(this.tree, { x: 0, y: 0, w: width, h: contentHeight }, ui);
    const grid = new Grid(width, height);
    paintLayout(grid, layout);
    if (this.options.showStatus) paintStatusBar(grid, this.statusText());

    const lines = grid.toLines(this.options.color);

    if (!this.options.interactive) {
      this.frameCount += 1;
      process.stdout.write(`${lines.join('\n')}\n`);
      if (this.options.frames !== null && this.frameCount >= this.options.frames) {
        this.stop(0);
      }
      return;
    }

    this.writeFrame(lines, width, height);
  }

  private writeFrame(lines: string[], width: number, height: number): void {
    const previous = this.lastFrame;
    const full = !previous || previous.width !== width || previous.height !== height;
    let out = '';

    if (full) {
      out += '\x1b[H';
      for (let i = 0; i < lines.length; i += 1) {
        out += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
      }
    } else {
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] !== previous.lines[i]) {
          out += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
        }
      }
    }

    if (out) process.stdout.write(`${out}\x1b[0m`);
    this.lastFrame = { width, height, lines };
  }

  private statusText(): string {
    const connection = this.connected ? 'ws:on' : 'ws:off';
    const focus = this.focusedId != null ? this.describeNode(this.focusedId) : '无焦点';
    const editing = this.editing ? ` | 编辑 ${codePointLength(this.editing.draft)} 字` : '';
    const hint = this.editing
      ? 'Tab 切换 · 输入文字 · Backspace 删除 · Ctrl+C 退出'
      : 'Tab 切换焦点 · Enter 触发 · Ctrl+C 退出';
    const notice = this.options.debug && this.lastNotice ? ` | ${this.lastNotice}` : '';
    return ` ${connection} | patch #${this.patchCount} | 焦点: ${focus}${editing} | ${hint}${notice} `;
  }

  private describeNode(id: number): string {
    const node = this.tree.get(id);
    if (!node) return `#${id}`;
    const text =
      node.type === 'Input' ? String(node.props.value ?? '') : this.tree.textOf(id);
    return `${node.type}#${id}${text ? ` ${text}` : ''}`;
  }

  private handleKey(sequence: string, key: Key): void {
    if (this.closed) return;

    const action = mapKey(sequence, key, this.editing !== null);
    switch (action.kind) {
      case 'quit':
        this.stop(0);
        break;
      case 'focusNext':
        this.moveFocus(action.delta);
        break;
      case 'activate':
        this.activateFocused();
        break;
      case 'inputInsert':
        this.editInsert(action.text);
        break;
      case 'inputBackspace':
        this.editBackspace();
        break;
      case 'inputDelete':
        this.editDelete();
        break;
      case 'inputLeft':
        this.editMoveCaret(-1);
        break;
      case 'inputRight':
        this.editMoveCaret(1);
        break;
      case 'inputHome':
        this.editSetCaret(0);
        break;
      case 'inputEnd':
        this.editSetCaret(codePointLength(this.editing?.draft ?? ''));
        break;
      case 'noop':
        break;
    }
  }

  private moveFocus(delta: 1 | -1): void {
    const order = this.tree.focusables();
    if (order.length === 0) {
      this.focus(null);
      return;
    }

    const current = this.focusedId != null ? order.indexOf(this.focusedId) : -1;
    const next =
      current < 0
        ? delta > 0
          ? 0
          : order.length - 1
        : (current + delta + order.length) % order.length;

    this.focus(order[next]);
  }

  private focus(id: number | null): void {
    this.focusedId = id;
    this.syncEditingWithFocus();
    this.requestRender();
  }

  private activateFocused(): void {
    if (this.focusedId == null) return;

    const node = this.tree.get(this.focusedId);
    if (!node || node.type !== 'Button') return;

    // 与浏览器一致：先 mousedown 链（handled 决定是否继续冒泡），再 click 链。
    for (const id of this.tree.chain(this.focusedId, 'onMouseDown')) {
      this.sendEvent(id, 'onMouseDown', {});
      if (this.tree.get(id)?.props.handled === true) break;
    }

    for (const id of this.tree.chain(this.focusedId, 'onClick')) {
      this.sendEvent(id, 'onClick', {});
    }
  }

  private sendEvent(id: number, name: string, payload: Record<string, unknown>): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`WS 未连接，事件丢弃 ${name}#${id}`);
      return;
    }

    const message: ClientEventMessage = { kind: 'event', id, name, payload };
    this.ws.send(JSON.stringify(message));
    this.log(`发送事件 ${name}#${id}`);
  }

  private editInsert(text: string): void {
    const editing = this.editing;
    if (!editing) return;

    const chars = Array.from(editing.draft);
    const inserted = Array.from(text);
    chars.splice(editing.caret, 0, ...inserted);
    editing.draft = chars.join('');
    editing.caret += inserted.length;
    this.commitEditing();
  }

  private editBackspace(): void {
    const editing = this.editing;
    if (!editing || editing.caret <= 0) return;

    const chars = Array.from(editing.draft);
    chars.splice(editing.caret - 1, 1);
    editing.draft = chars.join('');
    editing.caret -= 1;
    this.commitEditing();
  }

  private editDelete(): void {
    const editing = this.editing;
    if (!editing) return;

    const chars = Array.from(editing.draft);
    if (editing.caret >= chars.length) return;

    chars.splice(editing.caret, 1);
    editing.draft = chars.join('');
    this.commitEditing();
  }

  private editMoveCaret(delta: -1 | 1): void {
    const editing = this.editing;
    if (!editing) return;

    const length = codePointLength(editing.draft);
    editing.caret = Math.max(0, Math.min(length, editing.caret + delta));
    this.requestRender();
  }

  private editSetCaret(caret: number): void {
    const editing = this.editing;
    if (!editing) return;

    editing.caret = Math.max(0, Math.min(codePointLength(editing.draft), caret));
    this.requestRender();
  }

  private commitEditing(): void {
    const editing = this.editing;
    if (!editing) return;

    this.requestRender();

    const chain = this.tree.chain(editing.inputId, 'onChange');
    if (chain.length === 0) return;

    editing.sentValues.push(editing.draft);
    if (editing.sentValues.length > 50) editing.sentValues.shift();

    for (const id of chain) {
      this.sendEvent(id, 'onChange', { value: editing.draft });
    }
  }

  private setupTerminal(): void {
    if (this.terminalActive) return;
    this.terminalActive = true;

    if (this.options.altScreen) process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');

    const stdin = process.stdin as TtyReadStream;
    stdin.setRawMode(true);
    stdin.resume();
    readline.emitKeypressEvents(stdin);

    this.keypressHandler = (sequence: string, key: Key) => this.handleKey(sequence, key);
    stdin.on('keypress', this.keypressHandler);

    this.resizeHandler = () => {
      this.lastFrame = null;
      this.requestRender(true);
    };
    process.stdout.on('resize', this.resizeHandler);

    this.signalHandler = () => this.stop(0);
    process.on('SIGINT', this.signalHandler);
    process.on('SIGTERM', this.signalHandler);

    this.errorHandler = (error: unknown) => {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      this.error(`未捕获异常：${message}`);
      this.stop(1);
    };
    this.rejectionHandler = (reason: unknown) => {
      const message =
        reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      this.error(`未处理的 Promise 拒绝：${message}`);
      this.stop(1);
    };
    process.on('uncaughtException', this.errorHandler);
    process.on('unhandledRejection', this.rejectionHandler);
  }

  private teardownTerminal(): void {
    if (!this.terminalActive) return;
    this.terminalActive = false;

    const stdin = process.stdin as TtyReadStream;

    if (this.keypressHandler) {
      stdin.off('keypress', this.keypressHandler);
      this.keypressHandler = null;
    }
    if (this.resizeHandler) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.signalHandler) {
      process.off('SIGINT', this.signalHandler);
      process.off('SIGTERM', this.signalHandler);
      this.signalHandler = null;
    }
    if (this.errorHandler) {
      process.off('uncaughtException', this.errorHandler);
      this.errorHandler = null;
    }
    if (this.rejectionHandler) {
      process.off('unhandledRejection', this.rejectionHandler);
      this.rejectionHandler = null;
    }

    try {
      stdin.setRawMode(false);
    } catch {
      // 非 TTY 时忽略
    }
    stdin.pause();

    process.stdout.write('\x1b[0m\x1b[?25h');
    if (this.options.altScreen) process.stdout.write('\x1b[?1049l');
  }

  private clearTimers(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private log(message: string, detail?: unknown): void {
    this.lastNotice = detail === undefined ? message : `${message} ${safeJson(detail)}`;
    if (this.options.debug && !this.options.interactive) {
      process.stderr.write(`[tui] ${this.lastNotice}\n`);
    }
  }

  private error(message: string): void {
    this.lastNotice = message;
    this.fatalMessage = message;
  }
}
