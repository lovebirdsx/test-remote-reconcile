import type { CleanProps, Op } from '../renderer/ops';
import type { SnapshotNode } from '../renderer/snapshot';

/**
 * 终端侧的目标树。
 *
 * 作用与浏览器 interpreter.js 里的 DOM + 4 个 Map 等价：只保存
 * id / type / props / children / parent，不包含任何终端绘制逻辑。
 * op 的应用顺序和语义必须与浏览器端保持一致。
 */

export const ROOT_ID = 0;

export interface TNode {
  id: number;
  type: string;
  props: CleanProps;
  children: number[];
  parent: number | null;
}

export interface ApplyStats {
  created: number[];
  updated: number[];
  removed: number[];
  structureChanged: boolean;
}

function warn(message: string, detail: unknown): void {
  console.warn(`[tui] ${message}`, detail);
}

export class TargetTree {
  readonly nodes = new Map<number, TNode>();

  get(id: number): TNode | undefined {
    return this.nodes.get(id);
  }

  getRoot(): TNode | undefined {
    return this.nodes.get(ROOT_ID);
  }

  /** 快照里传的是根节点本身（id 0 / #root），这里整棵重建。 */
  applySnapshot(tree: SnapshotNode): void {
    this.nodes.clear();

    const visit = (snapshot: SnapshotNode, parent: number | null): number => {
      const node: TNode = {
        id: snapshot.id,
        type: snapshot.type,
        props: { ...(snapshot.props ?? {}) },
        children: [],
        parent,
      };
      this.nodes.set(node.id, node);
      for (const child of snapshot.children ?? []) {
        node.children.push(visit(child, node.id));
      }
      return node.id;
    };

    visit(tree, null);
  }

  /** 按消息里的原始顺序逐条应用；不能分类批处理。 */
  applyOps(ops: Op[]): ApplyStats {
    const stats: ApplyStats = {
      created: [],
      updated: [],
      removed: [],
      structureChanged: false,
    };

    for (const op of ops) {
      switch (op.op) {
        case 'create': {
          const node: TNode = {
            id: op.id,
            type: op.type,
            props: { ...op.props },
            children: [],
            parent: null,
          };
          this.nodes.set(node.id, node);
          stats.created.push(op.id);
          stats.structureChanged = true;
          break;
        }

        case 'insert': {
          const parent = this.nodes.get(op.parent);
          const child = this.nodes.get(op.child);
          if (!parent || !child) {
            warn(`insert 失败：#${op.child} -> #${op.parent}`, op);
            break;
          }
          // 先 detach 再 clamp，移动节点时下标才与服务端一致。
          this.detach(child);
          const index = Math.max(0, Math.min(op.index, parent.children.length));
          parent.children.splice(index, 0, child.id);
          child.parent = parent.id;
          stats.structureChanged = true;
          break;
        }

        case 'update': {
          const node = this.nodes.get(op.id);
          if (!node) {
            warn(`update 失败：#${op.id}`, op);
            break;
          }
          for (const [key, value] of Object.entries(op.patch)) {
            if (value === null) delete node.props[key];
            else node.props[key] = value;
          }
          stats.updated.push(op.id);
          break;
        }

        case 'remove': {
          const node = this.nodes.get(op.id);
          if (!node) {
            warn(`remove 失败：#${op.id}`, op);
            break;
          }
          // 服务端只发子树根 id，终端必须自己递归删除整棵子树。
          this.detach(node);
          this.removeSubtree(node, stats);
          stats.structureChanged = true;
          break;
        }
      }
    }

    return stats;
  }

  isFocusable(node: TNode): boolean {
    return node.type === 'Button' || node.type === 'Input';
  }

  /** 按文档顺序 DFS，不依赖 Map 的插入顺序。 */
  focusables(): number[] {
    const out: number[] = [];
    const walk = (id: number): void => {
      const node = this.nodes.get(id);
      if (!node) return;
      if (this.isFocusable(node)) out.push(id);
      for (const childId of node.children) walk(childId);
    };

    const root = this.getRoot();
    if (root) for (const childId of root.children) walk(childId);
    return out;
  }

  /**
   * 与浏览器 chainWithEvent 一致：从节点沿 parent 向上，
   * 不含根 id 0，收集声明了该事件的节点（子 -> 祖先）。
   */
  chain(startId: number, eventName: string): number[] {
    const out: number[] = [];
    let current: number | null = startId;

    while (current != null && current !== ROOT_ID) {
      const node = this.nodes.get(current);
      if (!node) break;
      const events = node.props.__events;
      if (Array.isArray(events) && events.includes(eventName)) out.push(current);
      current = node.parent;
    }

    return out;
  }

  /** 递归拼接节点下的所有文本，供 Text/Button 测量与绘制。 */
  textOf(id: number): string {
    const node = this.nodes.get(id);
    if (!node) return '';
    if (node.type === '#text') return String(node.props.text ?? '');
    return node.children.map((childId) => this.textOf(childId)).join('');
  }

  private detach(node: TNode): void {
    if (node.parent == null) return;
    const parent = this.nodes.get(node.parent);
    if (parent) {
      const index = parent.children.indexOf(node.id);
      if (index >= 0) parent.children.splice(index, 1);
    }
    node.parent = null;
  }

  private removeSubtree(node: TNode, stats: ApplyStats): void {
    for (const childId of [...node.children]) {
      const child = this.nodes.get(childId);
      if (child) this.removeSubtree(child, stats);
    }
    node.children = [];
    this.nodes.delete(node.id);
    stats.removed.push(node.id);
  }
}
