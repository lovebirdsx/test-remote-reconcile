import Reconciler = require('react-reconciler');
import type { ReactNode } from 'react';
import { cleanProps, type CleanProps, type Op } from './ops';
import { toSnapshot, type SnapshotNode } from './snapshot';

/**
 * Node 侧的“假节点树”。
 *
 * 它只是 id / type / props / children 的普通对象，没有任何渲染行为；
 * 真正的渲染发生在浏览器 interpreter.js。host config 的职责是把 React 的
 * 每次创建/插入/更新/删除翻译成这里的树变更 + 一批操作流。
 */
export interface FakeNode {
  id: number;
  type: string;
  props: Record<string, any>;
  children: FakeNode[];
  parent: FakeNode | null;
}

type Props = Record<string, any>;
type HostContext = Record<string, never>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

type DemoHostConfig = Reconciler.HostConfig<
  string,
  Props,
  FakeNode,
  FakeNode,
  FakeNode,
  FakeNode,
  FakeNode,
  FakeNode,
  HostContext,
  CleanProps,
  unknown,
  TimeoutHandle,
  number
>;

export interface DemoRenderer {
  render(element: ReactNode): void;
  snapshot(): SnapshotNode;
  nodeCount(): number;
  getNode(id: number): FakeNode | undefined;
  runHandler(id: number, name: string, payload: unknown): unknown;
}

const LEGACY_ROOT = 0;
const DEFAULT_EVENT_PRIORITY = 16; // React 18 的 DefaultLane / DefaultEventPriority
const EMPTY_CONTEXT: HostContext = {};

/** 比较清洗后的 props，得到浏览器可应用的 patch。children 不参与比较。 */
function diffProps(oldProps: Props, newProps: Props): CleanProps {
  const prev = cleanProps(oldProps);
  const next = cleanProps(newProps);
  const patch: CleanProps = {};

  for (const key of Object.keys(next)) {
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      patch[key] = next[key];
    }
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) patch[key] = null;
  }
  return patch;
}

export function createRenderer(onCommit: (ops: Op[]) => void): DemoRenderer {
  const root: FakeNode = {
    id: 0,
    type: '#root',
    props: {},
    children: [],
    parent: null,
  };

  const nodes = new Map<number, FakeNode>([[root.id, root]]);
  let nextId = 0;
  let currentOps: Op[] = [];
  let fiberRoot: any = null;

  function record(op: Op): void {
    currentOps.push(op);
  }

  function detach(node: FakeNode): void {
    if (!node.parent) return;
    const index = node.parent.children.indexOf(node);
    if (index >= 0) node.parent.children.splice(index, 1);
    node.parent = null;
  }

  /** 插入假树，返回最终下标（先把 child 从旧父节点摘掉再算）。 */
  function insertNode(parent: FakeNode, child: FakeNode, index: number): number {
    detach(child);
    const at = Math.max(0, Math.min(index, parent.children.length));
    parent.children.splice(at, 0, child);
    child.parent = parent;
    return at;
  }

  function removeSubtree(node: FakeNode): void {
    nodes.delete(node.id);
    for (const child of node.children) removeSubtree(child);
  }

  const hostConfig: DemoHostConfig = {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: false,
    warnsIfNotActing: false,
    noTimeout: -1,

    // React 在 render 阶段创建宿主元素时调用；创建假节点并记录 create。
    createInstance(type, props) {
      const node: FakeNode = {
        id: ++nextId,
        type,
        props,
        children: [],
        parent: null,
      };
      nodes.set(node.id, node);
      record({ op: 'create', id: node.id, type, props: cleanProps(props) });
      return node;
    },

    // React 在 render 阶段为文本子节点调用；文本也走独立的 #text 节点。
    createTextInstance(text) {
      const node: FakeNode = {
        id: ++nextId,
        type: '#text',
        props: { text },
        children: [],
        parent: null,
      };
      nodes.set(node.id, node);
      record({ op: 'create', id: node.id, type: '#text', props: cleanProps(node.props) });
      return node;
    },

    // 初次挂载/新子树在 completeWork 里组装时调用。
    // 这里必须记录 insert：create 操作本身不携带父子关系，
    // 浏览器要靠这些 insert 把新子树的内部结构拼起来（父节点此时还是游离的）。
    appendInitialChild(parentInstance, child) {
      const at = insertNode(parentInstance, child, parentInstance.children.length);
      record({ op: 'insert', parent: parentInstance.id, child: child.id, index: at });
    },

    // 子节点都挂好后调用；本 Demo 不需要 commitMount。
    finalizeInitialChildren() {
      return false;
    },

    // 宿主元素重渲染时在 render 阶段调用。
    // 返回 truthy 才会让 React 在 commit 阶段调用 commitUpdate；
    // 即使可见属性没变也返回 {}，保证事件处理器能被更新。
    prepareUpdate(_instance, _type, oldProps, newProps) {
      return diffProps(oldProps, newProps);
    },

    // commit mutation 阶段调用；更新原始 props（含事件函数），
    // 只有清洗后的可见差异才发 update。
    commitUpdate(instance, updatePayload, _type, _oldProps, nextProps) {
      instance.props = nextProps;
      if (updatePayload && Object.keys(updatePayload).length > 0) {
        record({ op: 'update', id: instance.id, patch: updatePayload });
      }
    },

    // 文本内容变化时在 commit mutation 阶段调用。
    commitTextUpdate(textInstance, _oldText, newText) {
      textInstance.props = { ...textInstance.props, text: newText };
      record({ op: 'update', id: textInstance.id, patch: { text: newText } });
    },

    // 本 Demo 永远让文本走 #text 节点，不走宿主自己管文本的优化。
    shouldSetTextContent() {
      return false;
    },

    // 每次开始新的 render 时，为根容器计算宿主上下文。
    getRootHostContext() {
      return EMPTY_CONTEXT;
    },
    // 宿主元素向下传上下文时调用；本 Demo 直接透传。
    getChildHostContext(parentHostContext) {
      return parentHostContext;
    },
    // ref / findHostInstance 需要把内部实例交给用户时调用。
    getPublicInstance(instance) {
      return instance;
    },

    // commit 开始（mutation 之前）调用。这里不能清空 ops：
    // 新节点的 create/insert 在 render 阶段就已经进入本批了。
    prepareForCommit() {
      return null;
    },

    // mutation 结束、layout effects 之前调用；统一 flush 本批操作。
    resetAfterCommit() {
      const batch = currentOps;
      currentOps = [];
      if (batch.length > 0) onCommit(batch);
    },

    // commit mutation 阶段：已挂载的父节点追加子节点。
    appendChild(parentInstance, child) {
      const at = insertNode(parentInstance, child, parentInstance.children.length);
      record({ op: 'insert', parent: parentInstance.id, child: child.id, index: at });
    },
    // commit mutation 阶段：有序插入/移动，beforeChild 决定插入下标。
    insertBefore(parentInstance, child, beforeChild) {
      if (child === beforeChild) return;
      detach(child);
      let at = parentInstance.children.indexOf(beforeChild);
      if (at < 0) at = parentInstance.children.length;
      at = insertNode(parentInstance, child, at);
      record({ op: 'insert', parent: parentInstance.id, child: child.id, index: at });
    },
    // commit mutation 阶段：根容器追加顶层节点。
    appendChildToContainer(container, child) {
      const at = insertNode(container, child, container.children.length);
      record({ op: 'insert', parent: container.id, child: child.id, index: at });
    },
    // commit mutation 阶段：根容器有序插入/移动。
    insertInContainerBefore(container, child, beforeChild) {
      if (child === beforeChild) return;
      detach(child);
      let at = container.children.indexOf(beforeChild);
      if (at < 0) at = container.children.length;
      at = insertNode(container, child, at);
      record({ op: 'insert', parent: container.id, child: child.id, index: at });
    },

    // commit mutation 阶段：从父节点删除一棵已挂载子树，只发子树根 id。
    removeChild(_parentInstance, child) {
      detach(child);
      record({ op: 'remove', id: child.id });
      removeSubtree(child);
    },
    // commit mutation 阶段：从根容器删除顶层节点。
    removeChildFromContainer(_container, child) {
      detach(child);
      record({ op: 'remove', id: child.id });
      removeSubtree(child);
    },

    // 根被清空/重置时调用；初始挂载时容器为空。
    clearContainer(container) {
      for (const child of [...container.children]) {
        detach(child);
        record({ op: 'remove', id: child.id });
        removeSubtree(child);
      }
    },

    // 删除的宿主实例彻底断开后调用；清掉 Node 侧 id 映射。
    detachDeletedInstance(node) {
      nodes.delete(node.id);
    },

    // finalizeInitialChildren 返回 true 时在 layout 阶段调用；本 Demo 不触发。
    commitMount() {},
    // shouldSetTextContent 由 true 变 false 时调用；本 Demo 永远返回 false。
    resetTextContent() {},
    // Suspense 隐藏宿主子树时调用；本 Demo 不用 Suspense。
    hideInstance() {},
    // Suspense 隐藏文本节点时调用。
    hideTextInstance() {},
    // Suspense 恢复宿主子树时调用。
    unhideInstance() {},
    // Suspense 恢复文本节点时调用。
    unhideTextInstance() {},
    // createPortal 挂载时调用；本 Demo 不用 portal。
    preparePortalMount() {},
    // React scope API 更新 scope 时调用；本 Demo 不用。
    prepareScopeUpdate() {},
    // React scope API 读取 scope 时调用；本 Demo 不用。
    getInstanceFromScope() {
      return null;
    },

    // DevTools/React 事件系统从宿主节点反查 fiber 时调用；本 Demo 不走 React 事件系统。
    getInstanceFromNode() {
      return null;
    },
    // ReactDOM 的 blur 选区钩子：失焦前调用；自定义渲染器不会走到。
    beforeActiveInstanceBlur() {},
    // ReactDOM 的 blur 选区钩子：失焦后调用。
    afterActiveInstanceBlur() {},

    // WS 回调里的 setState 不是 React 事件，React 会来问当前事件优先级。
    getCurrentEventPriority() {
      return DEFAULT_EVENT_PRIORITY;
    },

    // React 的 Suspense/调度超时：设置定时器。
    scheduleTimeout(fn, delay) {
      return setTimeout(fn, delay);
    },
    // React 的 Suspense/调度超时：取消定时器。
    cancelTimeout(id) {
      clearTimeout(id);
    },
  };

  const reconciler = Reconciler(hostConfig);

  function render(element: ReactNode): void {
    if (fiberRoot) {
      reconciler.updateContainer(element, fiberRoot, null, null);
      return;
    }
    fiberRoot = reconciler.createContainer(
      root,
      LEGACY_ROOT,
      null,
      false,
      null,
      '',
      (error: Error) => console.error('[node] recoverable error:', error),
      null,
    );
    reconciler.updateContainer(element, fiberRoot, null, null);
  }

  function snapshot(): SnapshotNode {
    return toSnapshot(root);
  }

  function nodeCount(): number {
    return nodes.size;
  }

  function getNode(id: number): FakeNode | undefined {
    return nodes.get(id);
  }

  function runHandler(id: number, name: string, payload: unknown): unknown {
    const node = nodes.get(id);
    if (!node) {
      console.warn(`[node] 事件目标不存在 #${id}`);
      return undefined;
    }
    const handler = node.props[name];
    if (typeof handler !== 'function') {
      console.warn(`[node] 节点 ${node.type}#${id} 没有 ${name}`);
      return undefined;
    }

    console.log('[node] Node 端收到事件', `${node.type}#${id}`, name, payload);
    const result = handler(payload);
    if (name === 'onMouseDown') {
      console.log('[node] onMouseDown 返回值', result);
    }
    return result;
  }

  return { render, snapshot, nodeCount, getNode, runHandler };
}
