declare module '@earendil-works/pi-tui' {
  export interface Component {
    render(width: number): string[];
    handleInput?(data: string): void;
    invalidate(): void;
  }

  export interface DefaultTextStyle {
    color?: (text: string) => string;
    bgColor?: (text: string) => string;
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
  }

  export interface MarkdownTheme {
    heading: (text: string) => string;
    link: (text: string) => string;
    linkUrl: (text: string) => string;
    code: (text: string) => string;
    codeBlock: (text: string) => string;
    codeBlockBorder: (text: string) => string;
    quote: (text: string) => string;
    quoteBorder: (text: string) => string;
    hr: (text: string) => string;
    listBullet: (text: string) => string;
    bold: (text: string) => string;
    italic: (text: string) => string;
    strikethrough: (text: string) => string;
    underline: (text: string) => string;
    highlightCode?: (code: string, lang?: string) => string[];
    codeBlockIndent?: string;
  }

  export interface SelectItem {
    value: string;
    label: string;
    description?: string;
  }

  export interface SelectListTheme {
    selectedPrefix: (text: string) => string;
    selectedText: (text: string) => string;
    description: (text: string) => string;
    scrollInfo: (text: string) => string;
    noMatch: (text: string) => string;
  }

  export interface OverlayOptions {
    width?: number | `${number}%`;
    minWidth?: number;
    maxHeight?: number | `${number}%`;
    anchor?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top-center' | 'bottom-center' | 'left-center' | 'right-center';
    offsetX?: number;
    offsetY?: number;
    row?: number | `${number}%`;
    col?: number | `${number}%`;
    margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
    visible?: (termWidth: number, termHeight: number) => boolean;
    nonCapturing?: boolean;
  }

  export interface OverlayHandle {
    hide(): void;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
    focus(): void;
    unfocus(): void;
    isFocused(): boolean;
  }

  export class Container implements Component {
    children: Component[];
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    invalidate(): void;
    render(width: number): string[];
  }

  export class Box implements Component {
    children: Component[];
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
    addChild(component: Component): void;
    removeChild(component: Component): void;
    clear(): void;
    setBgFn(bgFn?: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
  }

  export class ProcessTerminal {
    start(onInput: (data: string) => void, onResize: () => void): void;
    stop(): void;
    write(data: string): void;
    readonly columns: number;
    readonly rows: number;
    moveBy(lines: number): void;
    hideCursor(): void;
    showCursor(): void;
    clearLine(): void;
    clearFromCursor(): void;
    clearScreen(): void;
  }

  export class TUI {
    constructor(terminal: ProcessTerminal);
    children: Component[];
    addChild(component: Component): void;
    removeChild(component: Component): void;
    setFocus(component: Component | null): void;
    addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    hideOverlay(): void;
    hasOverlay(): boolean;
    start(): void;
    stop(): void;
    requestRender(force?: boolean): void;
  }

  export class Text implements Component {
    constructor(text: string, paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
    setText(text: string): void;
    setCustomBgFn(bgFn?: (text: string) => string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export class Input implements Component {
    focused: boolean;
    onSubmit?: (value: string) => void;
    constructor();
    setValue(value: string): void;
    getValue(): string;
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  }

  export class Loader implements Component {
    constructor(
      tui: TUI,
      spinnerColor: (text: string) => string,
      messageColor: (text: string) => string,
      message?: string,
    );
    start(): void;
    stop(): void;
    setMessage(message: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export class Markdown implements Component {
    constructor(text: string, paddingX: number, paddingY: number, theme: MarkdownTheme, defaultTextStyle?: DefaultTextStyle);
    setText(text: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export class SelectList implements Component {
    onSelect?: (item: SelectItem) => void;
    onCancel?: () => void;
    constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, layout?: Record<string, unknown>);
    setFilter(filter: string): void;
    setSelectedIndex(index: number): void;
    getSelectedItem(): SelectItem | null;
    handleInput(data: string): void;
    render(width: number): string[];
    invalidate(): void;
  }

  export function visibleWidth(text: string): number;
  export function truncateToWidth(text: string, maxWidth: number, ellipsis?: string, pad?: boolean): string;

  export function matchesKey(data: string, key: string): boolean;
}