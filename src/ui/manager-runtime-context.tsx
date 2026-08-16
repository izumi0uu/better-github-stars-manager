import { createContext, useContext, type ReactNode } from 'react';
import type { ManagerRuntime } from '@/runtime/manager-runtime';

const ManagerRuntimeContext = createContext<ManagerRuntime | null>(null);

export function ManagerRuntimeProvider({
  runtime,
  children,
}: {
  runtime: ManagerRuntime;
  children: ReactNode;
}) {
  return (
    <ManagerRuntimeContext.Provider value={runtime}>
      {children}
    </ManagerRuntimeContext.Provider>
  );
}

export function useOptionalManagerRuntime(): ManagerRuntime | null {
  return useContext(ManagerRuntimeContext);
}

export function useManagerRuntime(): ManagerRuntime {
  const runtime = useOptionalManagerRuntime();
  if (!runtime) throw new Error('ManagerRuntimeProvider is required.');
  return runtime;
}

export function useManagerNow(): number {
  return useOptionalManagerRuntime()?.now() ?? Date.now();
}
