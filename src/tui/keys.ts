import type { Key } from 'node:readline';

/**
 * readline keypress -> 终端动作。
 *
 * 只做无状态的按键归一化；焦点、draft、事件发送都在 session 里。
 */

export type KeyAction =
  | { kind: 'quit' }
  | { kind: 'focusNext'; delta: 1 | -1 }
  | { kind: 'activate' }
  | { kind: 'inputInsert'; text: string }
  | { kind: 'inputBackspace' }
  | { kind: 'inputDelete' }
  | { kind: 'inputLeft' }
  | { kind: 'inputRight' }
  | { kind: 'inputHome' }
  | { kind: 'inputEnd' }
  | { kind: 'noop' };

function printableText(sequence: string | undefined): string {
  if (!sequence) return '';
  let out = '';
  for (const ch of sequence) {
    const codePoint = ch.codePointAt(0) ?? 0;
    // 单行输入：过滤控制字符和 DEL，保留普通文字与输入法提交的字符串。
    if (codePoint >= 32 && codePoint !== 0x7f) out += ch;
  }
  return out;
}

export function mapKey(
  sequence: string | undefined,
  key: Key | undefined,
  editing: boolean,
): KeyAction {
  const name = key?.name;
  const ctrl = Boolean(key?.ctrl);
  const meta = Boolean(key?.meta);
  const shift = Boolean(key?.shift);

  if (ctrl && (name === 'c' || name === 'd')) return { kind: 'quit' };
  if (name === 'escape') return { kind: 'quit' };

  // Windows / 常见终端：Shift+Tab 可能以 \x1b[Z 到达。
  if (sequence === '\x1b[Z' || (name === 'tab' && shift)) {
    return { kind: 'focusNext', delta: -1 };
  }
  if (name === 'tab') return { kind: 'focusNext', delta: 1 };
  if (name === 'up') return { kind: 'focusNext', delta: -1 };
  if (name === 'down') return { kind: 'focusNext', delta: 1 };

  if (name === 'return' || name === 'enter') {
    // Input 编辑态下 Enter 移到下一个控件；Button 上 Enter 触发表单动作。
    return editing ? { kind: 'focusNext', delta: 1 } : { kind: 'activate' };
  }

  if (name === 'space' || sequence === ' ') {
    return editing ? { kind: 'inputInsert', text: ' ' } : { kind: 'activate' };
  }

  if (name === 'backspace' || sequence === '\x7f' || sequence === '\b') {
    return { kind: 'inputBackspace' };
  }
  if (name === 'delete') return { kind: 'inputDelete' };
  if (name === 'left') return { kind: 'inputLeft' };
  if (name === 'right') return { kind: 'inputRight' };
  if (name === 'home') return { kind: 'inputHome' };
  if (name === 'end') return { kind: 'inputEnd' };

  if (editing && !ctrl && !meta) {
    const text = printableText(sequence);
    if (text) return { kind: 'inputInsert', text };
  }

  return { kind: 'noop' };
}
