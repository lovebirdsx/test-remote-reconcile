import { createRoot } from 'react-dom/client';
import { App } from './app';

/**
 * M6 的浏览器入口：同一个 App，换成 react-dom 渲染。
 * app.tsx 和 widgets.tsx 都没有改；构建时只把 app.tsx 的 './widgets'
 * 别名到 widgets.dom.tsx，让控件落到原生 DOM 标签上。
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(<App />);
