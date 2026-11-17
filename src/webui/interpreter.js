/**
 * 浏览器端：没有 React，没有打包器。
 * 只做三件事：
 *   1. 把 snapshot 建成一棵真实 DOM；
 *   2. 把 patch 里的 create / insert / update / remove 应用到 DOM；
 *   3. 把原生事件变成 { kind: 'event' } 发回 Node。
 */

const rootEl = document.getElementById('root');

// id -> DOM 节点。root 的虚拟 id 固定为 0。
const nodes = new Map();
const props = new Map();
const types = new Map();
// 创建时的原始节点引用，用来证明增量更新没有换 DOM 节点。
const originals = new Map();

const logs = [];
window.__logs = logs;
window.__nodes = nodes;
window.__props = props;
window.__originals = originals;
window.__types = types;

function fmt(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.nodeType === 'number') return `<${value.nodeName}>`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function log(...args) {
  console.log(...args);
  logs.push({ t: Math.round(performance.now()), text: args.map(fmt).join(' ') });
  if (logs.length > 1000) logs.shift();
}

window.__identity = (id) => {
  const el = nodes.get(id);
  return {
    id,
    element: el,
    sameNode: el === originals.get(id),
    connected: Boolean(el && el.isConnected),
  };
};

const TAGS = {
  Box: 'div',
  Text: 'span',
  Button: 'button',
  Input: 'input',
  Border: 'div',
};

function resetRoot() {
  nodes.set(0, rootEl);
  props.set(0, {});
  types.set(0, '#root');
  originals.set(0, rootEl);
}

resetRoot();

function createNode(vnode) {
  let el;
  if (vnode.type === '#text') {
    el = document.createTextNode(String(vnode.props?.text ?? ''));
    el.__opId = vnode.id;
  } else {
    el = document.createElement(TAGS[vnode.type] || 'div');
    el.__opId = vnode.id;
    el.dataset.opId = String(vnode.id);
  }

  nodes.set(vnode.id, el);
  props.set(vnode.id, { ...(vnode.props || {}) });
  types.set(vnode.id, vnode.type);
  originals.set(vnode.id, el);

  if (vnode.type !== '#text') {
    applyElementProps(el, vnode.type, props.get(vnode.id));
  }
  return el;
}

function applyElementProps(el, type, p) {
  // 先清空本 Demo 管理的样式，再按当前 props 重新设置，
  // 这样 patch 里用 null 删除某个属性时也能正确清掉。
  el.style.display = '';
  el.style.flexDirection = '';
  el.style.gap = '';
  el.style.alignItems = '';
  el.style.justifyContent = '';
  el.style.padding = '';
  el.style.backgroundColor = '';
  el.style.borderRadius = '';
  el.style.color = '';
  el.style.fontSize = '';
  el.style.cursor = '';

  if (type === 'Box') {
    el.style.display = 'flex';
    el.style.flexDirection = p.direction === 'row' ? 'row' : 'column';
    if (p.gap != null) el.style.gap = `${p.gap}px`;
    if (p.align != null) el.style.alignItems = String(p.align);
    if (p.justify != null) el.style.justifyContent = String(p.justify);
  } else if (type === 'Border') {
    if (p.padding != null) el.style.padding = `${p.padding}px`;
    if (p.backgroundColor != null) el.style.backgroundColor = String(p.backgroundColor);
    if (p.radius != null) el.style.borderRadius = `${p.radius}px`;
  } else if (type === 'Text') {
    if (p.color != null) el.style.color = String(p.color);
    if (p.size != null) el.style.fontSize = `${p.size}px`;
  } else if (type === 'Button') {
    el.style.cursor = 'pointer';
  }

  if (type === 'Input') {
    if (p.value != null) {
      const next = String(p.value);
      // 受控输入每次 patch 回来都会重置 value，光标会跳到末尾：已知问题，不修。
      if (el.value !== next) el.value = next;
    }
    if (p.placeholder != null) el.setAttribute('placeholder', String(p.placeholder));
    else el.removeAttribute('placeholder');
  }
}

function buildFromSnapshot(vnode) {
  const el = createNode(vnode);
  if (vnode.type !== '#text') {
    for (const child of vnode.children || []) {
      el.appendChild(buildFromSnapshot(child));
    }
  }
  return el;
}

function applySnapshot(tree) {
  log('[web] 收到 snapshot', tree);

  while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
  nodes.clear();
  props.clear();
  types.clear();
  originals.clear();
  resetRoot();

  for (const child of tree.children || []) {
    rootEl.appendChild(buildFromSnapshot(child));
  }

  window.__tree = tree;
  log('[web] 快照重建完成，节点数', nodes.size);
}

function insertNode(parentId, childId, index) {
  const parentEl = nodes.get(parentId);
  const childEl = nodes.get(childId);
  if (!parentEl || !childEl) {
    log('[web] insert 失败：找不到节点', parentId, childId);
    return;
  }

  // 先 detach，再按 Node 端算好的 index 插入；移动节点的下标才一致。
  if (childEl.parentNode) childEl.parentNode.removeChild(childEl);
  const reference = parentEl.childNodes[index] || null;
  parentEl.insertBefore(childEl, reference);
  log('[web] insert', `#${childId}`, '->', `#${parentId}`, 'index', index);
}

function updateNode(id, patch) {
  const el = nodes.get(id);
  if (!el) {
    log('[web] update 失败：找不到节点', id);
    return;
  }

  const p = { ...(props.get(id) || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete p[key];
    else p[key] = value;
  }
  props.set(id, p);

  if (el.nodeType === Node.TEXT_NODE) {
    if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
      el.nodeValue = String(patch.text ?? '');
    }
    log('[web] update #text', `#${id}`, '->', el.nodeValue);
    return;
  }

  applyElementProps(el, types.get(id), p);
  log(
    '[web] update',
    types.get(id),
    `#${id}`,
    '同一 DOM 节点:',
    el === originals.get(id),
    '父元素:',
    el.parentElement,
  );
}

function removeNode(id) {
  const el = nodes.get(id);
  if (!el) {
    log('[web] remove 失败：找不到节点', id);
    return;
  }

  let removed = 0;
  const walk = (node) => {
    if (node.__opId != null) {
      removed += 1;
      nodes.delete(node.__opId);
      props.delete(node.__opId);
      types.delete(node.__opId);
      originals.delete(node.__opId);
    }
    for (const child of node.childNodes || []) walk(child);
  };
  walk(el);

  if (el.parentNode) el.parentNode.removeChild(el);
  log('[web] remove', `#${id}`, '子树节点数', removed);
}

function applyOp(op) {
  switch (op.op) {
    case 'create':
      createNode(op);
      log('[web] create', op.type, `#${op.id}`, op.props);
      break;
    case 'insert':
      insertNode(op.parent, op.child, op.index);
      break;
    case 'update':
      updateNode(op.id, op.patch);
      break;
    case 'remove':
      removeNode(op.id);
      break;
    default:
      log('[web] 未知 op', op);
  }
}

function getOpId(target) {
  let el = target;
  while (el && el !== rootEl) {
    if (el.__opId != null) return el.__opId;
    el = el.parentElement;
  }
  return el === rootEl ? 0 : null;
}

function parentOpId(id) {
  let el = nodes.get(id)?.parentElement;
  while (el && el !== rootEl) {
    if (el.__opId != null) return el.__opId;
    el = el.parentElement;
  }
  return 0;
}

function chainWithEvent(startId, eventName) {
  const chain = [];
  let id = startId;
  while (id != null && id !== 0) {
    const p = props.get(id);
    if (p && Array.isArray(p.__events) && p.__events.includes(eventName)) {
      chain.push(id);
    }
    id = parentOpId(id);
  }
  return chain;
}

function sendEvent(id, name, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    log('[web] WebSocket 未连接，事件丢弃', name, `#${id}`);
    return;
  }
  ws.send(JSON.stringify({ kind: 'event', id, name, payload }));
  log('[web] 发送事件', name, `#${id}`);
}

function onClick(event) {
  const start = getOpId(event.target);
  if (start == null) return;
  log('[web] 浏览器端发生点击', `#${start}`);
  for (const id of chainWithEvent(start, 'onClick')) {
    sendEvent(id, 'onClick', {});
  }
}

function onInput(event) {
  const start = getOpId(event.target);
  if (start == null) return;
  const value = event.target.value;
  log('[web] 浏览器端发生 input', `#${start}`, JSON.stringify(value));
  for (const id of chainWithEvent(start, 'onChange')) {
    sendEvent(id, 'onChange', { value });
  }
}

function onMouseDown(event) {
  const start = getOpId(event.target);
  if (start == null) return;
  log('[web] 浏览器端发生 mousedown', `#${start}`);

  // 声明式路由：浏览器从 props 里提前知道按钮是否已经“声明处理”，
  // 不需要问 Node，因此可以在同一个原生事件里决定是否继续冒泡给父容器。
  for (const id of chainWithEvent(start, 'onMouseDown')) {
    const handled = props.get(id)?.handled === true;
    log('[web] mousedown 路由到', `#${id}`, 'handled=', handled);
    sendEvent(id, 'onMouseDown', {});
    if (handled) break;
  }
}

rootEl.addEventListener('click', onClick);
rootEl.addEventListener('input', onInput);
rootEl.addEventListener('mousedown', onMouseDown);

const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProtocol}://${location.host}/ws`);

ws.onopen = () => log('[web] WS 已连接');
ws.onclose = () => log('[web] WS 已断开（刷新页面会建立新连接）');
ws.onerror = (event) => log('[web] WS 错误', event.type || String(event));

ws.onmessage = (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    log('[web] 收到非法 JSON');
    return;
  }

  if (message.kind === 'snapshot') {
    applySnapshot(message.tree);
  } else if (message.kind === 'patch') {
    log(
      '[web] 收到 patch（Node 的增量操作）',
      message.ops.length,
      '条',
      message.ops.map((op) => op.op).join(','),
    );
    for (const op of message.ops) applyOp(op);
  } else {
    log('[web] 未知消息', message.kind);
  }
};
