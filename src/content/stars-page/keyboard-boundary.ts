export function stopEditableKeydownAtShadowBoundary(event: Event): void {
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) {
    event.stopPropagation();
  }
}
