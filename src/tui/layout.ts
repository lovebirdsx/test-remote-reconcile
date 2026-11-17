import type { TargetTree, TNode } from './target';
import { parseColor, type Style } from './screen';
import { codePointLength, stringWidth } from './width';

/**
 * 极简盒模型布局：把 TargetTree 排成字符坐标。
 *
 * 只覆盖 Demo 用到的控件和 flex 子集：
 * - Box：row / column、gap、align、justify；
 * - Border：padding、backgroundColor、radius（只影响圆角字符）；
 * - Text / #text：单行、不换行；
 * - Button / Input：单行定高；
 * - 未知类型：透明 column 容器。
 *
 * 像素到字符格的换算是刻意的近似，见 README 的 TUI 章节。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InputView {
  display: string;
  placeholder: string;
  /** 编辑态时光标在 display 中的码点索引。 */
  caret?: number;
  focused: boolean;
}

export interface LayoutBox {
  id: number;
  type: string;
  rect: Rect;
  content: Rect;
  children: LayoutBox[];
  text?: string;
  textStyle: Style;
  boxStyle: Style;
  border: 'none' | 'square' | 'round';
  padding: number;
  focused: boolean;
  input?: InputView;
}

export interface UiState {
  focusId: number | null;
  editingId: number | null;
  draft: string;
  caret: number;
}

const PX_PER_CELL = 16;

const THEME = {
  buttonBg: parseColor('#e5e7eb'),
  buttonFg: parseColor('#1f2937'),
  focusBg: parseColor('#2563eb'),
  focusFg: parseColor('#ffffff'),
};

function pxToCells(value: unknown): number {
  const px = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.max(1, Math.round(px / PX_PER_CELL));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inset(rect: Rect, amount: number): Rect {
  return {
    x: rect.x + amount,
    y: rect.y + amount,
    w: Math.max(0, rect.w - amount * 2),
    h: Math.max(0, rect.h - amount * 2),
  };
}

function emptyRect(): Rect {
  return { x: 0, y: 0, w: 0, h: 0 };
}

interface Size {
  w: number;
  h: number;
}

function textStyleOf(node: TNode): Style {
  const style: Style = { fg: parseColor(node.props.color) };
  const size = typeof node.props.size === 'number' ? node.props.size : Number(node.props.size);
  if (Number.isFinite(size)) {
    if (size >= 18) style.bold = true;
    else if (size > 0 && size <= 12) style.dim = true;
  }
  return style;
}

function distributeShrink(natural: number[], available: number): number[] {
  const total = natural.reduce((sum, value) => sum + value, 0);
  if (total <= available || total === 0) {
    return natural.map((value) => Math.min(value, Math.max(0, available)));
  }

  const result = natural.map(() => 0);
  const fractions: Array<{ index: number; fraction: number }> = [];
  let used = 0;

  for (let i = 0; i < natural.length; i += 1) {
    const exact = (natural[i] * available) / total;
    const base = Math.floor(exact);
    result[i] = base;
    used += base;
    fractions.push({ index: i, fraction: exact - base });
  }

  fractions.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  let remainder = Math.max(0, available - used);
  for (let i = 0; remainder > 0 && i < fractions.length; i += 1, remainder -= 1) {
    result[fractions[i].index] += 1;
  }
  // available 比节点数还小时，前面已经被裁剪；这里不再强行每项至少 1。

  return result;
}

export function computeLayout(tree: TargetTree, viewport: Rect, ui: UiState): LayoutBox {
  const sizes = new Map<number, Size>();

  function measureNode(id: number): Size {
    const cached = sizes.get(id);
    if (cached) return cached;

    const node = tree.get(id);
    if (!node) {
      const empty = { w: 0, h: 0 };
      sizes.set(id, empty);
      return empty;
    }

    let size: Size;

    switch (node.type) {
      case '#text':
      case 'Text': {
        size = { w: stringWidth(tree.textOf(id)), h: 1 };
        break;
      }

      case 'Button': {
        size = { w: stringWidth(tree.textOf(id)) + 2, h: 1 };
        break;
      }

      case 'Input': {
        const editing = ui.editingId === id;
        const display = editing ? ui.draft : String(node.props.value ?? '');
        const placeholder = String(node.props.placeholder ?? '');
        const shown = display || placeholder;
        size = { w: clamp(stringWidth(shown) + 2, 12, 40), h: 1 };
        break;
      }

      case 'Border': {
        const padding = pxToCells(node.props.padding);
        const children = node.children.map(measureNode);
        const innerW = children.reduce((max, child) => Math.max(max, child.w), 0);
        const innerH = children.reduce((sum, child) => sum + child.h, 0);
        size = { w: innerW + padding * 2 + 2, h: innerH + padding * 2 + 2 };
        break;
      }

      case '#root':
      case 'Box':
      default: {
        const direction = node.type === 'Box' && node.props.direction === 'row' ? 'row' : 'column';
        const gap = node.type === 'Box' ? pxToCells(node.props.gap) : 0;
        const children = node.children.map(measureNode);
        const gapTotal = gap * Math.max(0, children.length - 1);

        if (direction === 'row') {
          size = {
            w: children.reduce((sum, child) => sum + child.w, 0) + gapTotal,
            h: children.reduce((max, child) => Math.max(max, child.h), 0),
          };
        } else {
          size = {
            w: children.reduce((max, child) => Math.max(max, child.w), 0),
            h: children.reduce((sum, child) => sum + child.h, 0) + gapTotal,
          };
        }
        break;
      }
    }

    sizes.set(id, size);
    return size;
  }

  function arrangeFlexChildren(
    node: TNode,
    content: Rect,
    direction: 'row' | 'column',
    gap: number,
    align: string,
    justify: string,
  ): LayoutBox[] {
    const childIds = node.children;
    if (childIds.length === 0) return [];

    const desired = childIds.map(measureNode);
    const mainSize = direction === 'row' ? content.w : content.h;
    const crossSize = direction === 'row' ? content.h : content.w;
    const naturalMain = desired.map((size) => (direction === 'row' ? size.w : size.h));
    const gapTotal = gap * Math.max(0, childIds.length - 1);
    const free = mainSize - (naturalMain.reduce((sum, value) => sum + value, 0) + gapTotal);

    let mainSizes: number[];
    const gaps = new Array<number>(Math.max(0, childIds.length - 1)).fill(gap);
    let start = 0;

    if (free >= 0) {
      mainSizes = naturalMain;

      if (justify === 'center') {
        start = Math.floor(free / 2);
      } else if (justify === 'flex-end') {
        start = free;
      } else if (justify === 'space-between' && childIds.length > 1) {
        const base = Math.floor(free / (childIds.length - 1));
        const remainder = free % (childIds.length - 1);
        for (let i = 0; i < gaps.length; i += 1) {
          gaps[i] = gap + base + (i < remainder ? 1 : 0);
        }
      }
    } else if (direction === 'row') {
      // 横向不够时按比例收缩，避免右侧溢出到别的布局里。
      mainSizes = distributeShrink(naturalMain, Math.max(0, mainSize - gapTotal));
    } else {
      // 纵向不够时保留自然高度，超出部分交给 Grid 裁剪（顶部内容优先可见）。
      mainSizes = naturalMain;
    }

    const offsets: number[] = [];
    let cursor = start;
    for (let i = 0; i < mainSizes.length; i += 1) {
      offsets.push(cursor);
      cursor += mainSizes[i] + (gaps[i] ?? 0);
    }

    const boxes: LayoutBox[] = [];
    for (let i = 0; i < childIds.length; i += 1) {
      const childId = childIds[i];
      const natural = desired[i];

      let childW: number;
      let childH: number;
      let crossOffset = 0;

      if (direction === 'row') {
        childW = mainSizes[i];
        childH = align === 'stretch' ? crossSize : natural.h;
        if (align === 'center') crossOffset = Math.max(0, Math.floor((crossSize - childH) / 2));
        else if (align === 'flex-end') crossOffset = Math.max(0, crossSize - childH);
      } else {
        childH = mainSizes[i];
        childW = align === 'stretch' ? crossSize : natural.w;
        if (align === 'center') crossOffset = Math.max(0, Math.floor((crossSize - childW) / 2));
        else if (align === 'flex-end') crossOffset = Math.max(0, crossSize - childW);
      }

      const childRect: Rect =
        direction === 'row'
          ? {
              x: content.x + offsets[i],
              y: content.y + crossOffset,
              w: Math.max(0, childW),
              h: Math.max(0, childH),
            }
          : {
              x: content.x + crossOffset,
              y: content.y + offsets[i],
              w: Math.max(0, childW),
              h: Math.max(0, childH),
            };

      boxes.push(arrangeNode(childId, childRect));
    }

    return boxes;
  }

  function baseBox(node: TNode, rect: Rect): LayoutBox {
    return {
      id: node.id,
      type: node.type,
      rect,
      content: rect,
      children: [],
      textStyle: {},
      boxStyle: {},
      border: 'none',
      padding: 0,
      focused: ui.focusId === node.id,
    };
  }

  function arrangeNode(id: number, rect: Rect): LayoutBox {
    const node = tree.get(id);
    if (!node) {
      return {
        id,
        type: '#missing',
        rect: emptyRect(),
        content: emptyRect(),
        children: [],
        textStyle: {},
        boxStyle: {},
        border: 'none',
        padding: 0,
        focused: false,
      };
    }

    switch (node.type) {
      case 'Box': {
        const box = baseBox(node, rect);
        const direction = node.props.direction === 'row' ? 'row' : 'column';
        const gap = pxToCells(node.props.gap);
        const align = String(node.props.align ?? 'stretch');
        const justify = String(node.props.justify ?? 'flex-start');
        box.children = arrangeFlexChildren(node, box.content, direction, gap, align, justify);
        return box;
      }

      case 'Border': {
        const box = baseBox(node, rect);
        const padding = pxToCells(node.props.padding);
        box.padding = padding;
        box.border = Number(node.props.radius ?? 0) > 0 ? 'round' : 'square';
        box.boxStyle = { bg: parseColor(node.props.backgroundColor) };
        box.content = inset(rect, padding + 1);
        box.children = arrangeFlexChildren(
          node,
          box.content,
          'column',
          0,
          'stretch',
          'flex-start',
        );
        return box;
      }

      case 'Text': {
        const box = baseBox(node, rect);
        box.text = tree.textOf(id);
        box.textStyle = textStyleOf(node);
        return box;
      }

      case '#text': {
        const box = baseBox(node, rect);
        box.text = String(node.props.text ?? '');
        return box;
      }

      case 'Button': {
        const box = baseBox(node, rect);
        box.text = tree.textOf(id);
        box.focused = ui.focusId === id;
        box.boxStyle = { bg: box.focused ? THEME.focusBg : THEME.buttonBg };
        box.textStyle = {
          fg: box.focused ? THEME.focusFg : THEME.buttonFg,
          bold: box.focused,
        };
        return box;
      }

      case 'Input': {
        const box = baseBox(node, rect);
        const editing = ui.editingId === id;
        const display = editing ? ui.draft : String(node.props.value ?? '');
        box.focused = ui.focusId === id;
        box.input = {
          display,
          placeholder: String(node.props.placeholder ?? ''),
          caret: editing ? clamp(ui.caret, 0, codePointLength(display)) : undefined,
          focused: box.focused,
        };
        box.textStyle = box.focused ? { underline: true } : {};
        return box;
      }

      default: {
        const box = baseBox(node, rect);
        box.children = arrangeFlexChildren(node, box.content, 'column', 0, 'stretch', 'flex-start');
        return box;
      }
    }
  }

  const rootNode = tree.getRoot();
  const rootBox: LayoutBox = {
    id: 0,
    type: '#root',
    rect: viewport,
    content: viewport,
    children: [],
    textStyle: {},
    boxStyle: {},
    border: 'none',
    padding: 0,
    focused: false,
  };

  if (rootNode) {
    rootBox.children = arrangeFlexChildren(
      rootNode,
      viewport,
      'column',
      0,
      'stretch',
      'flex-start',
    );
  }

  return rootBox;
}
