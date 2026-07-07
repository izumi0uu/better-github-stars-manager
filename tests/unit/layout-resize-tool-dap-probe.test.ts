/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { LayoutResizeTool, type LayoutResizeLiveAdapter, type LayoutResizeSession } from '@/ui/layout-resize-tool';

function pointerEventLike(target: HTMLElement, pointerId: number, clientX: number) {
  return {
    pointerId,
    clientX,
    currentTarget: target,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe('DAP layout resize tool probe', () => {
  it('DAP probe invariant: active pointer commits the full live snapshot before session cleanup', () => {
    const handle = document.createElement('button');
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => true);
    handle.releasePointerCapture = vi.fn();

    let session: LayoutResizeSession | null = null;
    const renderTransitions: Array<{ render: boolean; liveWidth: number | null }> = [];
    const commits: Array<Partial<Record<string, number>>> = [];
    const cleanup = vi.fn<NonNullable<LayoutResizeLiveAdapter['cleanup']>>();
    const paint = vi.fn<LayoutResizeLiveAdapter['paint']>();
    const measureStart = vi.fn<NonNullable<LayoutResizeLiveAdapter['measureStart']>>();
    const adapter: LayoutResizeLiveAdapter = { measureStart, paint, cleanup };

    const currentSession = () => {
      expect(session).not.toBeNull();
      return session as LayoutResizeSession;
    };

    const tool = new LayoutResizeTool({
      getSession: () => session,
      setSession: (next, options) => {
        session = next;
        renderTransitions.push({ render: options.render, liveWidth: next?.liveWidth ?? null });
      },
      getAdapter: () => adapter,
      onCommit: (liveWidths) => commits.push(liveWidths),
    });

    expect(tool.onPointerDown({
      event: pointerEventLike(handle, 17, 100),
      id: 'description',
      frozenWidths: { repository: 240, description: 280, language: 80 },
      defaultWidth: 320,
    })).toBe(true);

    expect(measureStart).toHaveBeenCalledWith(expect.objectContaining({
      id: 'description',
      pointerId: 17,
      startWidth: 280,
      defaultWidth: 320,
      liveWidth: 280,
    }));

    tool.onPointerMove({ pointerId: 99, clientX: 700 } as PointerEvent);
    expect(currentSession().liveWidth).toBe(280);
    expect(paint).not.toHaveBeenCalled();

    tool.onPointerMove({ pointerId: 17, clientX: 160 } as PointerEvent);
    expect(currentSession().liveWidth).toBe(340);
    expect(currentSession().liveWidths).toMatchObject({
      repository: 240,
      description: 340,
      language: 80,
    });
    expect(paint).toHaveBeenCalledWith(expect.objectContaining({
      id: 'description',
      pointerId: 17,
      liveWidth: 340,
      delta: 60,
    }));
    expect(renderTransitions.at(-1)).toEqual({ render: false, liveWidth: 340 });

    tool.onPointerUp({ pointerId: 99 } as PointerEvent);
    expect(currentSession().liveWidth).toBe(340);
    expect(commits).toHaveLength(0);

    tool.onPointerUp({ pointerId: 17 } as PointerEvent);

    expect(commits).toEqual([{ repository: 240, description: 340, language: 80 }]);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(17);
    expect(cleanup).toHaveBeenCalledWith('commit');
    expect(session).toBeNull();
    expect(tool.state).toEqual({ name: 'idle' });
    expect(renderTransitions.at(-1)).toEqual({ render: true, liveWidth: null });
  });
});
