/**
 * 跨进程操作流的最小定义。
 *
 * 所有发往浏览器的数据都必须先过 clean()/cleanProps()：
 * - WebSocket 只能传 JSON，函数和 undefined 不能直接过去；
 *   JSON.stringify 会静默丢掉它们，导致 create 和 update 的 props 形状
 *   在两端悄悄不一致。
 * - 浮点尾数、颜色写法（#abc / rgb() / #RRGGBB）需要统一，
 *   否则浏览器端无法可靠比较和应用。
 * - React element、内部对象可能带循环引用，也应被过滤掉。
 */

export type CleanValue =
  | null
  | boolean
  | number
  | string
  | CleanValue[]
  | { [key: string]: CleanValue };

export type CleanProps = Record<string, CleanValue>;

export type CreateOp = {
  op: 'create';
  id: number;
  type: string;
  props: CleanProps;
};

export type InsertOp = {
  op: 'insert';
  parent: number;
  child: number;
  index: number;
};

export type UpdateOp = {
  op: 'update';
  id: number;
  patch: CleanProps;
};

export type RemoveOp = {
  op: 'remove';
  id: number;
};

export type Op = CreateOp | InsertOp | UpdateOp | RemoveOp;

function cleanInner(value: unknown, seen: Set<object>): CleanValue | undefined {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as string | boolean;
  if (type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) return undefined; // NaN / Infinity 不是合法 JSON 值
    const rounded = Math.round(n * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    return undefined;
  }

  if (Array.isArray(value)) {
    // 数组里被过滤的值保留为 null，避免下标错位。
    return value.map((item) => cleanInner(item, seen) ?? null);
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;

    // React element：不是可序列化的业务数据，直接丢掉。
    if ('$$typeof' in obj) return undefined;

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return undefined;

    if (seen.has(obj)) return undefined; // 循环引用
    seen.add(obj);
    const out: Record<string, CleanValue> = {};
    for (const [key, item] of Object.entries(obj)) {
      const cleaned = cleanInner(item, seen);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    seen.delete(obj);
    return out;
  }

  return undefined;
}

/** 清洗任意跨进程值（props、事件 payload 等）。 */
export function clean(value: unknown): CleanValue | undefined {
  return cleanInner(value, new Set());
}

function normalizeColor(input: string): string {
  const s = input.trim().toLowerCase();

  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    return '#' + m[1].split('').map((c) => c + c).join('');
  }

  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1];

  // 带 alpha 的 hex：本 Demo 不支持透明度，丢掉 alpha。
  m = /^#([0-9a-f]{4})$/.exec(s);
  if (m) return '#' + m[1].slice(0, 3).split('').map((c) => c + c).join('');

  m = /^#([0-9a-f]{8})$/.exec(s);
  if (m) return '#' + m[1].slice(0, 6);

  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\s*\)$/.exec(s);
  if (m) {
    const toHex = (x: string) => {
      const n = Math.max(0, Math.min(255, Math.round(Number(x))));
      return n.toString(16).padStart(2, '0');
    };
    return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
  }

  // 命名色（red / transparent 等）不在本 Demo 的 clean 范围内，原样保留。
  return input;
}

function normalizeColorsDeep(value: CleanValue): CleanValue {
  if (Array.isArray(value)) return value.map(normalizeColorsDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, CleanValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        typeof item === 'string' && /color/i.test(key)
          ? normalizeColor(item)
          : normalizeColorsDeep(item);
    }
    return out;
  }
  return value;
}

/**
 * host props -> 线上 props。
 *
 * - children 由节点树的 children 表达，不重复放进 props（它可能是 React element，
 *   带循环引用）。
 * - 函数不能过线：以 on 开头的事件函数折叠成保留键 __events，
 *   浏览器只需要知道“要绑哪些事件”，不需要函数本身。
 * - undefined / 非普通对象 / React element 被 clean 丢弃。
 * - 数字保留 2 位，颜色统一成 #RRGGBB。
 */
export function cleanProps(props: Record<string, unknown>): CleanProps {
  const out: CleanProps = {};
  const events: string[] = [];

  for (const [key, raw] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;

    if (typeof raw === 'function') {
      if (key.length > 2 && key.startsWith('on') && /^[A-Z]/.test(key[2])) {
        events.push(key);
      }
      continue;
    }

    const cleaned = clean(raw);
    if (cleaned === undefined) continue;
    out[key] = normalizeColorsDeep(cleaned);
  }

  if (events.length > 0) out.__events = events.sort();
  return out;
}
