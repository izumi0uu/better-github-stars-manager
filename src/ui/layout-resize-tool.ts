import {
  COLUMN_DEFS,
  clampColumnWidth,
  normalizedColumnWidth,
  resizeSnapshot,
  type ColumnId,
} from '@/ui/column-layout';

export type LayoutResizeSession = {
  id: ColumnId;
  pointerId: number;
  captureTarget: HTMLElement;
  startX: number;
  startWidth: number;
  defaultWidth: number;
  minWidth: number;
  frozenWidths: Partial<Record<ColumnId, number>>;
  liveWidths: Partial<Record<ColumnId, number>>;
  liveWidth: number;
  delta: number;
  snappedToDefault: boolean;
  atDefaultWidth: boolean;
  atMinWidth: boolean;
};

export type LayoutResizeLiveState = Omit<LayoutResizeSession, 'captureTarget'>;

export type LayoutResizeToolState =
  | { name: 'idle' }
  | { name: 'pointing'; pointerId: number; id: ColumnId }
  | { name: 'dragging'; session: LayoutResizeSession };

export type LayoutResizeLiveAdapter = {
  measureStart?: (resize: LayoutResizeLiveState) => void;
  paint: (resize: LayoutResizeLiveState) => void;
  cleanup?: (outcome: 'commit' | 'cancel') => void;
};

type ResizePointerLike = {
  pointerId: number;
  clientX: number;
  currentTarget: EventTarget & HTMLElement;
  preventDefault: () => void;
  stopPropagation: () => void;
};

type LayoutResizeToolOptions = {
  getSession: () => LayoutResizeSession | null;
  setSession: (session: LayoutResizeSession | null, options: { render: boolean }) => void;
  getAdapter: () => LayoutResizeLiveAdapter | null;
  onCommit: (liveWidths: Partial<Record<ColumnId, number>>) => void;
  onStart?: () => void;
  onClear?: () => void;
};

export class LayoutResizeTool {
  private readonly options: LayoutResizeToolOptions;
  state: LayoutResizeToolState = { name: 'idle' };

  constructor(options: LayoutResizeToolOptions) {
    this.options = options;
  }

  onPointerDown({ event, id, frozenWidths, defaultWidth }: {
    event: ResizePointerLike;
    id: ColumnId;
    frozenWidths: Partial<Record<ColumnId, number>>;
    defaultWidth?: number;
  }): boolean {
    if (this.options.getSession()) return false;
    const startWidth = normalizedColumnWidth(id, frozenWidths[id]);
    if (startWidth == null) return false;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const baselineWidth = normalizedColumnWidth(id, defaultWidth) ?? startWidth;
    const minWidth = COLUMN_DEFS[id].minWidth;
    const session: LayoutResizeSession = {
      id,
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      startX: event.clientX,
      startWidth,
      defaultWidth: baselineWidth,
      minWidth,
      frozenWidths,
      liveWidths: frozenWidths,
      liveWidth: startWidth,
      delta: 0,
      snappedToDefault: false,
      atDefaultWidth: baselineWidth === startWidth,
      atMinWidth: startWidth <= minWidth,
    };

    this.state = { name: 'pointing', pointerId: event.pointerId, id };
    this.options.onStart?.();
    this.options.setSession(session, { render: true });
    this.options.getAdapter()?.measureStart?.(toLiveState(session));
    this.state = { name: 'dragging', session };
    return true;
  }

  onPointerMove(event: Pick<PointerEvent, 'pointerId' | 'clientX'>): void {
    const current = this.options.getSession();
    if (!current || event.pointerId !== current.pointerId) return;

    const liveWidths = resizeSnapshot(current.frozenWidths, current.id, event.clientX - current.startX, current.defaultWidth);
    const liveWidth = normalizedColumnWidth(current.id, liveWidths[current.id]) ?? current.startWidth;
    const defaultWidth = clampColumnWidth(current.id, current.defaultWidth);
    const next: LayoutResizeSession = {
      ...current,
      liveWidths,
      liveWidth,
      delta: liveWidth - current.startWidth,
      snappedToDefault: liveWidth === defaultWidth && current.startWidth !== defaultWidth,
      atDefaultWidth: liveWidth === defaultWidth,
      atMinWidth: liveWidth <= current.minWidth,
    };

    this.state = { name: 'dragging', session: next };
    const adapter = this.options.getAdapter();
    if (adapter) {
      this.options.setSession(next, { render: false });
      adapter.paint(toLiveState(next));
      return;
    }
    this.options.setSession(next, { render: true });
  }

  onPointerUp(event: Pick<PointerEvent, 'pointerId'>): void {
    const current = this.options.getSession();
    if (!current || event.pointerId !== current.pointerId) return;
    this.finish(true);
  }

  onPointerCancel(event: Pick<PointerEvent, 'pointerId'>): void {
    const current = this.options.getSession();
    if (!current || event.pointerId !== current.pointerId) return;
    this.finish(false);
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.options.getSession()) return;
    event.preventDefault();
    this.finish(false);
  }

  finish(commit: boolean): void {
    const current = this.options.getSession();
    if (!current) return;
    if (commit) this.options.onCommit(current.liveWidths);
    this.releasePointer(current);
    this.options.getAdapter()?.cleanup?.(commit ? 'commit' : 'cancel');
    this.options.setSession(null, { render: true });
    this.options.onClear?.();
    this.state = { name: 'idle' };
  }

  disposeActiveGesture(): void {
    const current = this.options.getSession();
    if (!current) return;
    this.releasePointer(current);
    this.options.getAdapter()?.cleanup?.('cancel');
    this.options.setSession(null, { render: false });
    this.options.onClear?.();
    this.state = { name: 'idle' };
  }

  private releasePointer(session: LayoutResizeSession): void {
    if (session.captureTarget.hasPointerCapture?.(session.pointerId)) {
      session.captureTarget.releasePointerCapture?.(session.pointerId);
    }
  }
}

export function toLiveState(session: LayoutResizeSession): LayoutResizeLiveState {
  const { captureTarget: _captureTarget, ...live } = session;
  return live;
}
