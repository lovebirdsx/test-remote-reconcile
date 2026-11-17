import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as React from 'react';
import { App } from './app';
import { createRenderer } from './renderer/hostConfig';
import { clean, type Op } from './renderer/ops';
import type { SnapshotNode } from './renderer/snapshot';

const HOST = '127.0.0.1';
const PORT = 8787;
const WEBUI_DIR = path.resolve(process.cwd(), 'src/webui');

const STATIC_ROUTES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/interpreter.js': { file: 'interpreter.js', contentType: 'text/javascript; charset=utf-8' },
  '/web': { file: 'web.html', contentType: 'text/html; charset=utf-8' },
  '/web-bundle.js': { file: 'web-bundle.js', contentType: 'text/javascript; charset=utf-8' },
};

const clients = new Set<WebSocket>();
let commitCount = 0;

function countSnapshot(node: SnapshotNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countSnapshot(child), 0);
}

function summarizeOps(ops: Op[]): string {
  return ops.map((op) => op.op).join(',');
}

const renderer = createRenderer((ops) => {
  commitCount += 1;
  console.log(
    `[node] commit #${commitCount}，${ops.length} 条 ops [${summarizeOps(ops)}]`,
  );

  if (clients.size === 0) {
    console.log('[node] 当前没有客户端，本批 ops 丢弃（新客户端靠快照）');
    return;
  }

  const message = JSON.stringify({ kind: 'patch', ops });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
});

function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = (req.url ?? '/').split('?')[0];

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  const route = STATIC_ROUTES[pathname];
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 ${pathname}\n`);
    return;
  }

  const filePath = path.join(WEBUI_DIR, route.file);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${route.file} 读取失败：${error.message}\n`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': route.contentType,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function handleClientMessage(socket: WebSocket, raw: RawData): void {
  let message: any;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    console.warn('[node] 收到非法 JSON', raw.toString().slice(0, 200));
    return;
  }

  if (message.kind === 'event') {
    const id = Number(message.id);
    const name = String(message.name);
    const payload = clean(message.payload) ?? {};
    renderer.runHandler(id, name, payload);
    return;
  }

  console.warn('[node] 未知消息 kind:', message.kind);
}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  clients.add(socket);
  console.log('[node] 新客户端连接，发送快照');

  const tree = renderer.snapshot();
  socket.send(JSON.stringify({ kind: 'snapshot', tree }));
  console.log(
    `[node] 快照已发送，节点数 ${countSnapshot(tree)}，客户端数 ${clients.size}`,
  );

  socket.on('message', (raw) => handleClientMessage(socket, raw));
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[node] 客户端断开，剩余 ${clients.size}`);
  });
  socket.on('error', (error) => console.error('[node] WebSocket 错误', error));
});

console.log('[node] 渲染 App...');
renderer.render(React.createElement(App));
console.log(`[node] 初始渲染完成，假节点数 ${renderer.nodeCount()}`);

server.listen(PORT, HOST, () => {
  console.log(`[node] HTTP/WS 监听 http://${HOST}:${PORT}`);
  console.log(`[node] 远程页面 http://${HOST}:${PORT}/`);
  console.log(`[node] react-dom 页面 http://${HOST}:${PORT}/web`);
});

server.on('error', (error) => {
  console.error('[node] HTTP 服务启动失败', error);
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  console.log('\n[node] 收到 SIGINT，退出');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
