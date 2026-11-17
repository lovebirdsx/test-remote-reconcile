import * as React from 'react';

/**
 * 极简控件封装。
 *
 * Node 侧这里只把业务 props 变成宿主类型字符串（'Box' / 'Text' / ...），
 * 不实现任何渲染行为；真正的 DOM 行为在浏览器 interpreter.js。
 * M6 会有一份 widgets.dom.tsx，把同样的控件映射到原生 DOM 标签。
 */

export type Direction = 'row' | 'column';
export type Align = 'flex-start' | 'center' | 'flex-end' | 'stretch';
export type Justify = 'flex-start' | 'center' | 'flex-end' | 'space-between';

export interface BoxProps {
  children?: React.ReactNode;
  direction?: Direction;
  gap?: number;
  align?: Align;
  justify?: Justify;
}

export function Box(props: BoxProps) {
  return React.createElement('Box', props);
}

export interface TextProps {
  children?: React.ReactNode;
  color?: string;
  size?: number;
}

export function Text(props: TextProps) {
  return React.createElement('Text', props);
}

export interface ButtonProps {
  children?: React.ReactNode;
  onClick?: () => void;
  onMouseDown?: () => boolean | void;
  /** 声明式事件路由：true 表示按钮自己处理，不再冒泡给父容器。 */
  handled?: boolean;
}

export function Button(props: ButtonProps) {
  return React.createElement('Button', props);
}

export interface InputChangeEvent {
  value: string;
}

export interface InputProps {
  value: string;
  onChange?: (event: InputChangeEvent) => void;
  placeholder?: string;
}

export function Input(props: InputProps) {
  return React.createElement('Input', props);
}

export interface BorderProps {
  children?: React.ReactNode;
  padding?: number;
  backgroundColor?: string;
  radius?: number;
  onMouseDown?: () => boolean | void;
}

export function Border(props: BorderProps) {
  return React.createElement('Border', props);
}

export interface CounterProps {
  value: number;
  onIncrement: () => void;
}

/** 组合控件：验证组合组件最终仍然只落到 4 个基础宿主控件上。 */
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
