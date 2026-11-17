import * as React from 'react';
import type {
  BorderProps,
  BoxProps,
  ButtonProps,
  CounterProps,
  InputProps,
  TextProps,
} from './widgets';

/**
 * M6：同名控件的 DOM 实现。
 *
 * app.tsx 一个字不改，esbuild 构建时把 app.tsx 里的 './widgets'
 * 别名到本文件，于是同一份 App 由 react-dom 直接渲染成原生 DOM。
 * 这里的 props -> CSS 映射与浏览器 interpreter.js 必须保持一致。
 */

const px = (value?: number) => (value == null ? undefined : `${value}px`);

export function Box({ children, direction = 'column', gap, align, justify }: BoxProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction,
        gap: px(gap),
        alignItems: align,
        justifyContent: justify,
      }}
    >
      {children}
    </div>
  );
}

export function Text({ children, color, size }: TextProps) {
  return <span style={{ color, fontSize: px(size) }}>{children}</span>;
}

export function Button({ children, onClick, onMouseDown, handled }: ButtonProps) {
  return (
    <button
      style={{ cursor: 'pointer' }}
      onClick={onClick ? () => onClick() : undefined}
      onMouseDown={
        onMouseDown
          ? (event) => {
              // 与远程解释器的声明式路由等价：handled=true 时不让父容器收到 mousedown。
              if (handled) event.stopPropagation();
              onMouseDown();
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}

export function Input({ value, onChange, placeholder }: InputProps) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={onChange ? (event) => onChange({ value: event.target.value }) : undefined}
    />
  );
}

export function Border({ children, padding, backgroundColor, radius, onMouseDown }: BorderProps) {
  return (
    <div
      style={{
        padding: px(padding),
        backgroundColor,
        borderRadius: px(radius),
      }}
      onMouseDown={onMouseDown ? () => onMouseDown() : undefined}
    >
      {children}
    </div>
  );
}

export function Counter({ value, onIncrement }: CounterProps) {
  return (
    <Border padding={12} backgroundColor="#eef3ff" radius={6}>
      <Box direction="row" gap={8} align="center">
        <Text>count: {value}</Text>
        <Button onClick={onIncrement}>+1</Button>
      </Box>
    </Border>
  );
}
