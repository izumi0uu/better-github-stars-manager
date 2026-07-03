import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('shadow-root portal primitives', () => {
  it('keeps popover content portaled through the shared shadow-root container', () => {
    const popoverSource = readFileSync('src/ui/shadcn/popover.tsx', 'utf8');

    expect(popoverSource).toContain('const Popover = PopoverPrimitive.Root;');
    expect(popoverSource).toContain('const container = usePortalContainer();');
    expect(popoverSource).toContain("align = 'start'");
    expect(popoverSource).toContain('sideOffset = 4');
    expect(popoverSource).toContain('gsm-z-popover w-72 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none');
    expect(popoverSource).toContain('<PopoverPrimitive.Portal container={container}>{content}</PopoverPrimitive.Portal>');
    expect(popoverSource).toContain('<PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>');
    expect(popoverSource).not.toContain('PopoverPrimitive.Root {...props}');
  });

  it('keeps the other Radix content primitives on the same portal-container pattern', () => {
    const selectSource = readFileSync('src/ui/shadcn/select.tsx', 'utf8');
    const tooltipSource = readFileSync('src/ui/shadcn/tooltip.tsx', 'utf8');

    expect(selectSource).toContain('const container = usePortalContainer();');
    expect(selectSource).toContain('<SelectPrimitive.Portal container={container}>');
    expect(tooltipSource).toContain('const container = usePortalContainer();');
    expect(tooltipSource).toContain('<TooltipPrimitive.Portal container={container}>{content}</TooltipPrimitive.Portal>');
  });
});
