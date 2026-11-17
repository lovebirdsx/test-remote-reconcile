import * as esbuild from 'esbuild';
import path from 'node:path';

/**
 * M6 专用的一次性构建：浏览器不认 TSX，也不能直接 import npm 的 CJS React，
 * 所以这里把 web-render.tsx + app + widgets.dom + react-dom 打成一个 ESM 文件。
 * M1–M5 的远程页面完全不经过这个构建。
 */
await esbuild.build({
  entryPoints: ['src/web-render.tsx'],
  outfile: 'src/webui/web-bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  logLevel: 'info',
  plugins: [
    {
      name: 'alias-dom-widgets',
      setup(build) {
        build.onResolve({ filter: /^\.\/widgets$/ }, (args) => {
          // 只替换 app.tsx 对控件的引用；widgets.dom.tsx 自己的类型 import 不受影响。
          if (args.importer.endsWith('app.tsx')) {
            return { path: path.resolve('src/widgets.dom.tsx') };
          }
          return undefined;
        });
      },
    },
  ],
});

console.log('[build] src/webui/web-bundle.js');
