import type { LayoutBox } from './layout';
import { Grid, parseColor, type RGB, type Style } from './screen';
import { sliceDisplay, stringWidth, toCodePoints, truncateToWidth } from './width';

/**
 * 把 LayoutBox 栅格化到 Grid。
 *
 * 背景色沿树向下继承：Border 画完背景后，子节点文字只改前景色/样式，
 * 不会把父容器的背景覆盖掉。
 */

const BORDER_STYLE: Style = { fg: parseColor('#9ca3af') };
const PLACEHOLDER_STYLE: Style = { fg: parseColor('#9ca3af'), dim: true };
const STATUS_STYLE: Style = { fg: parseColor('#6b7280') };

export function paintLayout(grid: Grid, root: LayoutBox): void {
  paintBox(grid, root, undefined);
}

function paintBox(grid: Grid, box: LayoutBox, inheritedBg: RGB | undefined): void {
  const bg = box.boxStyle.bg ?? inheritedBg;

  if (bg) {
    grid.fillRect(box.rect.x, box.rect.y, box.rect.w, box.rect.h, { bg });
  }

  switch (box.type) {
    case 'Border':
      drawBorder(grid, box, bg);
      break;
    case 'Text':
    case '#text':
      drawText(grid, box, bg);
      break;
    case 'Button':
      drawButton(grid, box, bg);
      break;
    case 'Input':
      drawInput(grid, box, bg);
      break;
    default:
      break;
  }

  for (const child of box.children) paintBox(grid, child, bg);
}

function drawBorder(grid: Grid, box: LayoutBox, bg: RGB | undefined): void {
  const { x, y, w, h } = box.rect;
  if (w < 2 || h < 2) return;

  const style: Style = { ...BORDER_STYLE, bg };
  const corners =
    box.border === 'round'
      ? { tl: '╭', tr: '╮', bl: '╰', br: '╯' }
      : { tl: '┌', tr: '┐', bl: '└', br: '┘' };
  const horizontal = '─'.repeat(Math.max(0, w - 2));

  grid.writeText(x, y, corners.tl + horizontal + corners.tr, style, w);
  grid.writeText(x, y + h - 1, corners.bl + horizontal + corners.br, style, w);

  for (let yy = y + 1; yy < y + h - 1; yy += 1) {
    grid.writeText(x, yy, '│', style, 1);
    grid.writeText(x + w - 1, yy, '│', style, 1);
  }
}

function drawText(grid: Grid, box: LayoutBox, bg: RGB | undefined): void {
  if (!box.text) return;
  const style: Style = { ...box.textStyle, bg };
  grid.writeText(box.rect.x, box.rect.y, box.text, style, box.rect.w);
}

function drawButton(grid: Grid, box: LayoutBox, bg: RGB | undefined): void {
  const style: Style = { ...box.textStyle, bg };
  grid.writeText(box.rect.x, box.rect.y, `[${box.text ?? ''}]`, style, box.rect.w);
}

function drawInput(grid: Grid, box: LayoutBox, bg: RGB | undefined): void {
  const input = box.input;
  if (!input) return;

  const { x, y, w } = box.rect;
  if (w <= 0) return;

  const contentX = x + 1;
  const contentW = Math.max(0, w - 2);
  const baseStyle: Style = { ...box.textStyle, bg };

  grid.writeText(x, y, '[', baseStyle, 1);
  if (w >= 2) grid.writeText(x + w - 1, y, ']', baseStyle, 1);

  const showPlaceholder = input.display.length === 0 && !input.focused;
  const shown = showPlaceholder ? input.placeholder : input.display;
  const style: Style = showPlaceholder ? { ...PLACEHOLDER_STYLE, bg } : baseStyle;

  if (!input.focused || input.caret === undefined || contentW === 0) {
    grid.writeText(contentX, y, truncateToWidth(shown, contentW), style, contentW);
    return;
  }

  // 编辑态：按显示列计算水平滚动，再用软件光标画 caret。
  const chars = toCodePoints(input.display);
  const caret = Math.max(0, Math.min(input.caret, chars.length));
  const caretCol = stringWidth(chars.slice(0, caret).join(''));
  const scroll = caretCol >= contentW ? caretCol - (contentW - 1) : 0;
  const slice = sliceDisplay(input.display, scroll, contentW);

  if (slice.padLeft > 0) {
    grid.writeText(contentX, y, ' '.repeat(slice.padLeft), style, contentW);
  }
  grid.writeText(
    contentX + slice.padLeft,
    y,
    slice.text,
    style,
    Math.max(0, contentW - slice.padLeft),
  );

  const caretX = contentX + Math.max(0, Math.min(contentW - 1, caretCol - scroll));
  const remaining = contentW - (caretX - contentX);
  let caretChar = chars[caret] ?? ' ';
  if (stringWidth(caretChar) > remaining) caretChar = ' ';

  grid.writeText(caretX, y, caretChar, { ...style, inverse: true }, remaining);
}

/** 状态栏独占最后一行；文本过长按显示宽度截断。 */
export function paintStatusBar(grid: Grid, text: string): void {
  const y = grid.height - 1;
  if (y < 0) return;

  grid.fillRect(0, y, grid.width, 1, STATUS_STYLE);
  grid.writeText(0, y, truncateToWidth(text, grid.width), STATUS_STYLE, grid.width);
}
