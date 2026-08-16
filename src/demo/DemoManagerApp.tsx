import { useCallback, useMemo, useState } from 'react';
import { DemoShell } from '@/demo/DemoShell';
import { demoCopyFor } from '@/demo/demo-copy';
import { DEMO_BUILD_CANARY } from '@/demo/fixtures';
import { createDemoManagerRuntime } from '@/demo/runtime';
import { I18nProvider, useI18n } from '@/i18n';
import type { ManagerRuntime } from '@/runtime/manager-runtime';
import {
  ManagerWorkspace,
  type ManagerWorkspaceExtension,
} from '@/ui/ManagerWorkspace';
import { ManagerRuntimeProvider } from '@/ui/manager-runtime-context';
import { useTheme } from '@/ui/hooks/use-theme';

export function DemoManagerApp() {
  const [blockedLinkVisible, setBlockedLinkVisible] = useState(false);
  const runtime = useMemo(() => createDemoManagerRuntime({
    onBlockedLink: () => setBlockedLinkVisible(true),
  }), []);

  return (
    <ManagerRuntimeProvider runtime={runtime}>
      <I18nProvider source={runtime}>
        <DemoManagerSurface
          runtime={runtime}
          blockedLinkVisible={blockedLinkVisible}
          onBlockedLinkDismiss={() => setBlockedLinkVisible(false)}
        />
      </I18nProvider>
    </ManagerRuntimeProvider>
  );
}

function DemoManagerSurface({
  runtime,
  blockedLinkVisible,
  onBlockedLinkDismiss,
}: Readonly<{
  runtime: ManagerRuntime;
  blockedLinkVisible: boolean;
  onBlockedLinkDismiss: () => void;
}>) {
  const { locale } = useI18n();
  const { theme, themeClass } = useTheme();
  const [resetEpoch, setResetEpoch] = useState(0);
  const copy = demoCopyFor(locale).shell;
  const extension = useMemo<ManagerWorkspaceExtension>(() => ({
    info: blockedLinkVisible ? copy.syntheticLinkBlocked : null,
    onClearInfo: onBlockedLinkDismiss,
  }), [blockedLinkVisible, copy.syntheticLinkBlocked, onBlockedLinkDismiss]);

  const reset = useCallback(async () => {
    const nextEpoch = await runtime.reset();
    onBlockedLinkDismiss();
    setResetEpoch(nextEpoch);
  }, [onBlockedLinkDismiss, runtime]);

  return (
    <div
      className={themeClass}
      data-testid="demo-theme-scope"
      data-demo-build={DEMO_BUILD_CANARY}
      data-demo-theme={theme}
    >
      <DemoShell
        interactiveDemo={(
          <ManagerWorkspace
            key={`demo-workspace-${resetEpoch}`}
            extension={extension}
            allowHashTagOverride={false}
          />
        )}
        onReset={reset}
        resetEpoch={resetEpoch}
      />
    </div>
  );
}
