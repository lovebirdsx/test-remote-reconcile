import { useEffect, useState } from 'react';
import { Border, Box, Button, Counter, Input, Text } from './widgets';

/**
 * 业务代码：只依赖 widgets，不 import react-dom / react-reconciler。
 * 同一份 App 会被 Node 的远程渲染器和浏览器里的 react-dom 分别渲染。
 */
export function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('remote');
  const [flash, setFlash] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // M2：每秒自增，用来观察 update 操作和 DOM 节点身份。
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  // M5：父容器高亮只持续 320ms。
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), 320);
    return () => clearTimeout(timer);
  }, [flash]);

  const increment = () => {
    console.log('[node] Node 端状态变更：count + 1');
    setCount((value) => value + 1);
  };

  return (
    <Box direction="column" gap={12}>
      <Text color="#1f2937" size={20}>
        Remote React Demo
      </Text>

      <Counter value={count} onIncrement={increment} />

      <Box direction="row" gap={8} align="center">
        <Text color="#374151">name:</Text>
        <Input
          value={name}
          onChange={(event) => setName(event.value)}
          placeholder="type here"
        />
      </Box>

      <Box direction="row" gap={8} align="center">
        <Button onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? '隐藏详情' : '显示详情'}
        </Button>
        <Text color="#4b5563">动态子树：验证 create + insert + remove</Text>
      </Box>

      {showDetails ? (
        <Border padding={8} backgroundColor="#f9fafb" radius={4}>
          <Text color="#374151">
            这段内容只在 showDetails=true 时存在：Node 会发 create / insert，关闭时发 remove。
          </Text>
        </Border>
      ) : null}

      <Border
        padding={12}
        backgroundColor={flash ? '#ffe08a' : '#f3f4f6'}
        radius={6}
        onMouseDown={() => {
          console.log('[node] 父容器 onMouseDown → 高亮');
          setFlash(true);
        }}
      >
        <Box direction="column" gap={8}>
          <Box direction="row" gap={8} align="center">
            <Button
              handled
              onMouseDown={() => {
                console.log('[node] Button onMouseDown → true（已处理）');
                return true;
              }}
              onClick={increment}
            >
              handled 按钮
            </Button>
            <Text color="#4b5563">handled=true：父容器不应高亮</Text>
          </Box>

          <Box direction="row" gap={8} align="center">
            <Button
              onMouseDown={() => {
                console.log('[node] 普通 Button onMouseDown → false');
                return false;
              }}
              onClick={increment}
            >
              普通按钮
            </Button>
            <Text color="#4b5563">未声明 handled：父容器会高亮</Text>
          </Box>
        </Box>
      </Border>

      <Text color="#6b7280" size={12}>
        刷新页面会靠 Node 当前状态的快照重建整棵树。
      </Text>
    </Box>
  );
}
