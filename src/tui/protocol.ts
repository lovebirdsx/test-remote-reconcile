import type { Op } from '../renderer/ops';
import type { SnapshotNode } from '../renderer/snapshot';

/**
 * 终端客户端复用的线上协议。
 *
 * 这里只做 type-only import：运行时不会把 react-reconciler / hostConfig
 * 拉进 TUI 进程。消息格式与 src/webui/interpreter.js 完全相同。
 */

export type ServerMessage =
  | { kind: 'snapshot'; tree: SnapshotNode }
  | { kind: 'patch'; ops: Op[] };

export interface ClientEventMessage {
  kind: 'event';
  id: number;
  name: string;
  payload: Record<string, unknown>;
}
