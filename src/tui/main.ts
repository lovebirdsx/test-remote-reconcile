import type { ColorMode } from './screen';
import { TuiSession, type TuiOptions } from './session';

/**
 * 终端 TUI renderer 入口。
 *
 * 它是一个独立的 WS 客户端：连接现有 node-render.ts 的 /ws，
 * 消费 snapshot + patch，回传 event；不加载 React，也不启动第二个 reconciler。
 */

const USAGE = `终端 TUI renderer —— 连接现有 remote-reconcile Node 服务

用法:
  npm run tui                交互模式：Tab 切换焦点，Enter 触发按钮
  npm run tui:once           连接后输出一帧并退出
  npm run tui:frames         输出 snapshot 帧 + 1 个 patch 帧
  npx tsx src/tui/main.ts [options]

选项:
  --url <ws://...>       服务端地址（默认 ws://127.0.0.1:8787/ws）
  --once                 收到 snapshot 后输出一帧并退出
  --frames <n>           渲染 n 帧后退出（snapshot 为第 1 帧）
  --width <n>            非交互模式宽度（默认 80）
  --height <n>           非交互模式高度（默认 24）
  --color <mode>         auto|truecolor|256|16|none（默认 auto）
  --no-color             等价于 --color none
  --no-alt-screen        不进入备用屏幕（旧 conhost 可尝试）
  --no-status            不绘制底部状态栏
  --no-reconnect         交互模式断线后不自动重连
  --timeout-ms <n>       非交互模式等待超时（默认 5000）
  --debug                调试日志（非交互模式写 stderr）
  -h, --help             显示帮助

快捷键:
  Tab / Shift+Tab        切换焦点
  Enter / Space          触发 Button；Input 编辑时 Enter 移到下一个控件
  ← → Home End           移动 Input 光标
  Backspace / Delete     删除字符
  Ctrl+C / Esc           退出
`;

interface CliOptions {
  url: string;
  width: number;
  height: number;
  color: ColorMode | 'auto';
  once: boolean;
  frames: number | null;
  timeoutMs: number;
  altScreen: boolean;
  showStatus: boolean;
  reconnect: boolean;
  debug: boolean;
  help: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseInteger(value: string, name: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    fail(`${name} 必须是 >= ${min} 的整数`);
  }
  return parsed;
}

function readValue(
  argv: string[],
  index: number,
  argument: string,
  name: string,
): { value: string; next: number } {
  const equals = argument.indexOf('=');
  if (equals >= 0) {
    return { value: argument.slice(equals + 1), next: index + 1 };
  }

  const value = argv[index + 1];
  if (value === undefined) fail(`${name} 需要一个值`);
  return { value, next: index + 2 };
}

function matches(argument: string, name: string): boolean {
  return argument === name || argument.startsWith(`${name}=`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    url: 'ws://127.0.0.1:8787/ws',
    width: 80,
    height: 24,
    color: 'auto',
    once: false,
    frames: null,
    timeoutMs: 5000,
    altScreen: true,
    showStatus: true,
    reconnect: true,
    debug: false,
    help: false,
  };

  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];

    if (argument === '--once') {
      options.once = true;
      index += 1;
    } else if (argument === '--no-color') {
      options.color = 'none';
      index += 1;
    } else if (argument === '--no-alt-screen') {
      options.altScreen = false;
      index += 1;
    } else if (argument === '--no-status') {
      options.showStatus = false;
      index += 1;
    } else if (argument === '--no-reconnect') {
      options.reconnect = false;
      index += 1;
    } else if (argument === '--debug') {
      options.debug = true;
      index += 1;
    } else if (argument === '-h' || argument === '--help') {
      options.help = true;
      index += 1;
    } else if (matches(argument, '--url')) {
      const result = readValue(argv, index, argument, '--url');
      options.url = result.value;
      index = result.next;
    } else if (matches(argument, '--frames')) {
      const result = readValue(argv, index, argument, '--frames');
      options.frames = parseInteger(result.value, '--frames', 1);
      index = result.next;
    } else if (matches(argument, '--width')) {
      const result = readValue(argv, index, argument, '--width');
      options.width = parseInteger(result.value, '--width', 1);
      index = result.next;
    } else if (matches(argument, '--height')) {
      const result = readValue(argv, index, argument, '--height');
      options.height = parseInteger(result.value, '--height', 1);
      index = result.next;
    } else if (matches(argument, '--timeout-ms')) {
      const result = readValue(argv, index, argument, '--timeout-ms');
      options.timeoutMs = parseInteger(result.value, '--timeout-ms', 1);
      index = result.next;
    } else if (matches(argument, '--color')) {
      const result = readValue(argv, index, argument, '--color');
      if (
        result.value !== 'auto' &&
        result.value !== 'truecolor' &&
        result.value !== '256' &&
        result.value !== '16' &&
        result.value !== 'none'
      ) {
        fail('--color 只支持 auto|truecolor|256|16|none');
      }
      options.color = result.value;
      index = result.next;
    } else {
      fail(`未知参数：${argument}`);
    }
  }

  return options;
}

function resolveColor(mode: ColorMode | 'auto'): ColorMode {
  if (mode !== 'auto') return mode;

  const colorterm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
    return 'truecolor';
  }

  const term = (process.env.TERM ?? '').toLowerCase();
  if (term === 'dumb') return 'none';
  if (term.includes('256')) return '256';
  return process.platform === 'win32' ? 'truecolor' : '256';
}

/** `tui:once | head` 之类的管道提前关闭时，不要让 EPIPE 变成未捕获异常。 */
function installPipeGuards(): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  process.stderr.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
  });
}

function main(): void {
  installPipeGuards();

  let cli: CliOptions;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[tui] ${message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (cli.help) {
    process.stdout.write(USAGE);
    return;
  }

  const frames = cli.once ? (cli.frames === null ? 1 : Math.min(cli.frames, 1)) : cli.frames;
  const interactive = frames === null;

  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    process.stderr.write(
      '[tui] 当前不是交互式终端；请使用 --once / --frames，或在真实终端中运行。\n',
    );
    process.exitCode = 2;
    return;
  }

  const options: TuiOptions = {
    url: cli.url,
    width: cli.width,
    height: cli.height,
    color: resolveColor(cli.color),
    interactive,
    altScreen: cli.altScreen,
    showStatus: cli.showStatus,
    frames,
    timeoutMs: cli.timeoutMs,
    reconnect: cli.reconnect,
    debug: cli.debug,
  };

  const session = new TuiSession(options);
  session.start();
}

main();
