import { charWidth } from './width';

/**
 * 终端字符网格。
 *
 * 用 Cell Grid 而不是逐行字符串，才能正确处理：
 * - 嵌套背景色（Border 背景 + Text 前景）；
 * - 宽字符占两格、组合字符附加；
 * - 焦点反显和 Input 光标精确覆盖；
 * - 行级 diff 重绘。
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Style {
  fg?: RGB;
  bg?: RGB;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export type ColorMode = 'truecolor' | '256' | '16' | 'none';

export interface Cell {
  ch: string;
  width: 0 | 1 | 2;
  style: Style;
  /** 宽字符右边的占位格：不输出字符。 */
  cont?: boolean;
}

export const EMPTY_STYLE: Style = {};

function space(style: Style = EMPTY_STYLE): Cell {
  return { ch: ' ', width: 1, style };
}

export class Grid {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cells = new Array(this.width * this.height);
    for (let i = 0; i < this.cells.length; i += 1) {
      this.cells[i] = space();
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  cellAt(x: number, y: number): Cell | undefined {
    return this.inBounds(x, y) ? this.cells[y * this.width + x] : undefined;
  }

  fillRect(x: number, y: number, w: number, h: number, style: Style = EMPTY_STYLE): void {
    if (w <= 0 || h <= 0) return;

    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    if (x0 >= x1 || y0 >= y1) return;

    for (let yy = y0; yy < y1; yy += 1) {
      // 填充边界如果切开了宽字符，把另一半也清掉，避免悬挂的 cont。
      this.clearWideAt(x0, yy);
      this.clearWideAt(x1 - 1, yy);
      const edge = this.cellAt(x1, yy);
      if (edge?.cont && x1 - 1 >= 0) {
        this.cells[yy * this.width + (x1 - 1)] = space();
        this.cells[yy * this.width + x1] = space();
      }

      for (let xx = x0; xx < x1; xx += 1) {
        this.cells[yy * this.width + xx] = space(style);
      }
    }
  }

  /** 写一段文本，返回实际占用的显示列数。 */
  writeText(
    x: number,
    y: number,
    text: string,
    style: Style = EMPTY_STYLE,
    maxWidth: number = this.width - x,
  ): number {
    if (y < 0 || y >= this.height || maxWidth <= 0) return 0;

    let cursor = x;
    let used = 0;

    for (const ch of text) {
      const w = charWidth(ch.codePointAt(0) ?? 0);

      if (w === 0) {
        // 组合字符附加到前一个 lead cell。
        let px = cursor - 1;
        if (px >= 0) {
          let cell = this.cellAt(px, y);
          if (cell?.cont && px > 0) {
            px -= 1;
            cell = this.cellAt(px, y);
          }
          if (cell && !cell.cont) cell.ch += ch;
        }
        continue;
      }

      // 完全在左侧裁剪区之外的字符直接跳过。
      if (cursor + w <= 0) {
        cursor += w;
        continue;
      }

      if (used + w > maxWidth) {
        // 还剩 1 列但下一字符宽 2：用空格占位后停止，不写半个字符。
        if (used < maxWidth && cursor >= 0 && cursor < this.width) {
          this.clearWideAt(cursor, y);
          this.cells[y * this.width + cursor] = space(style);
        }
        break;
      }

      if (cursor + w > this.width) break;

      if (cursor >= 0) {
        this.clearWideAt(cursor, y);
        if (w === 2) this.clearWideAt(cursor + 1, y);

        this.cells[y * this.width + cursor] = {
          ch,
          width: w as 1 | 2,
          style,
        };
        if (w === 2) {
          this.cells[y * this.width + cursor + 1] = {
            ch: '',
            width: 0,
            style,
            cont: true,
          };
        }
      }

      cursor += w;
      used += w;
    }

    return used;
  }

  /** 输出每一行的 ANSI 文本（行尾复位）。mode=none 时输出纯文本。 */
  toLines(mode: ColorMode): string[] {
    const lines: string[] = [];

    for (let y = 0; y < this.height; y += 1) {
      let out = '';

      if (mode === 'none') {
        for (let x = 0; x < this.width; x += 1) {
          const cell = this.cells[y * this.width + x];
          if (cell.cont) continue;
          out += cell.ch || ' ';
          if (cell.width === 2) x += 1;
        }
        lines.push(out);
        continue;
      }

      let current: Style = EMPTY_STYLE;
      let styled = false;

      for (let x = 0; x < this.width; x += 1) {
        const cell = this.cells[y * this.width + x];
        if (cell.cont) continue;

        if (!sameStyle(cell.style, current)) {
          out += '\x1b[0m';
          out += styleToAnsi(cell.style, mode);
          current = cell.style;
          styled = true;
        }

        out += cell.ch || ' ';
        if (cell.width === 2) x += 1; // 跳过 cont 占位格
      }

      if (styled) out += '\x1b[0m';
      lines.push(out);
    }

    return lines;
  }

  private clearWideAt(x: number, y: number): void {
    const cell = this.cellAt(x, y);
    if (!cell) return;

    if (cell.cont) {
      if (x > 0) this.cells[y * this.width + x - 1] = space();
      this.cells[y * this.width + x] = space();
      return;
    }

    if (cell.width === 2) {
      this.cells[y * this.width + x] = space();
      if (x + 1 < this.width) this.cells[y * this.width + x + 1] = space();
    }
  }
}

function sameRgb(a: RGB | undefined, b: RGB | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    sameRgb(a.fg, b.fg) &&
    sameRgb(a.bg, b.bg) &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.inverse) === Boolean(b.inverse)
  );
}

function styleToAnsi(style: Style, mode: ColorMode): string {
  const parts: string[] = [];
  if (style.bold) parts.push('1');
  if (style.dim) parts.push('2');
  if (style.underline) parts.push('4');
  if (style.inverse) parts.push('7');

  if (mode !== 'none') {
    if (style.fg) parts.push(fgToAnsi(style.fg, mode));
    if (style.bg) parts.push(bgToAnsi(style.bg, mode));
  }

  return parts.length > 0 ? `\x1b[${parts.join(';')}m` : '';
}

function fgToAnsi(rgb: RGB, mode: ColorMode): string {
  if (mode === 'truecolor') return `38;2;${rgb.r};${rgb.g};${rgb.b}`;
  if (mode === '256') return `38;5;${ansi256Index(rgb)}`;
  return String(30 + ansi16Index(rgb));
}

function bgToAnsi(rgb: RGB, mode: ColorMode): string {
  if (mode === 'truecolor') return `48;2;${rgb.r};${rgb.g};${rgb.b}`;
  if (mode === '256') return `48;5;${ansi256Index(rgb)}`;
  return String(40 + ansi16Index(rgb));
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestCubeLevel(value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < CUBE_LEVELS.length; i += 1) {
    const distance = Math.abs(CUBE_LEVELS[i] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function ansi256Index(rgb: RGB): number {
  const r6 = nearestCubeLevel(rgb.r);
  const g6 = nearestCubeLevel(rgb.g);
  const b6 = nearestCubeLevel(rgb.b);
  const cubeIndex = 16 + 36 * r6 + 6 * g6 + b6;
  const cubeRgb = {
    r: CUBE_LEVELS[r6],
    g: CUBE_LEVELS[g6],
    b: CUBE_LEVELS[b6],
  };

  const grayLevel = Math.max(
    0,
    Math.min(23, Math.round(((rgb.r + rgb.g + rgb.b) / 3 - 8) / 10)),
  );
  const grayIndex = 232 + grayLevel;
  const grayValue = 8 + grayLevel * 10;

  const cubeDistance =
    (rgb.r - cubeRgb.r) ** 2 + (rgb.g - cubeRgb.g) ** 2 + (rgb.b - cubeRgb.b) ** 2;
  const grayDistance =
    (rgb.r - grayValue) ** 2 + (rgb.g - grayValue) ** 2 + (rgb.b - grayValue) ** 2;

  return cubeDistance <= grayDistance ? cubeIndex : grayIndex;
}

function ansi16Index(rgb: RGB): number {
  let index = 0;
  if (rgb.r >= 128) index |= 1;
  if (rgb.g >= 128) index |= 2;
  if (rgb.b >= 128) index |= 4;
  return index;
}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  teal: '#008080',
  navy: '#000080',
  purple: '#800080',
  orange: '#ffa500',
};

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** 解析 #RGB / #RRGGBB / rgb() / 常见命名色；未知值返回 undefined。 */
export function parseColor(value: unknown): RGB | undefined {
  if (typeof value !== 'string') return undefined;

  const text = value.trim().toLowerCase();
  if (!text || text === 'transparent' || text === 'none') return undefined;

  if (text.startsWith('#')) {
    let hex = text.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .slice(0, 3)
        .split('')
        .map((ch) => ch + ch)
        .join('');
    } else if (hex.length === 8) {
      hex = hex.slice(0, 6);
    }
    if (!/^[0-9a-f]{6}$/.test(hex)) return undefined;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(text);
  if (match) {
    return {
      r: clampChannel(Number(match[1])),
      g: clampChannel(Number(match[2])),
      b: clampChannel(Number(match[3])),
    };
  }

  const named = NAMED_COLORS[text];
  if (named) return parseColor(named);
  return undefined;
}
