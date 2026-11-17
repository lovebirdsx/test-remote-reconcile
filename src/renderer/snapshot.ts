import { cleanProps, type CleanProps } from './ops';
import type { FakeNode } from './hostConfig';

/**
 * 假节点树 -> 浏览器可消费的纯 JSON。
 * 快照和增量 patch 使用同一套 cleanProps 规则，保证刷新后的 props
 * 与增量更新后的 props 完全一致。
 */
export interface SnapshotNode {
  id: number;
  type: string;
  props: CleanProps;
  children: SnapshotNode[];
}

export function toSnapshot(node: FakeNode): SnapshotNode {
  return {
    id: node.id,
    type: node.type,
    props: cleanProps(node.props),
    children: node.children.map(toSnapshot),
  };
}
