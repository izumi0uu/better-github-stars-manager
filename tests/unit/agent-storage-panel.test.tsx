/**
 * @vitest-environment jsdom
 */
import { act, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentStoragePanel,
  formatStorageBytes,
} from "@/options/AgentStoragePanel";
import type { AgentStorageUsageSnapshot } from "@/storage/agent-storage-store";
import {
  cleanupMountedRootsAndBody,
  click,
  mountReact,
  type MountedRoot,
} from "./test-utils";

const MiB = 1_024 * 1_024;
const mountedRoots: MountedRoot[] = [];

function usage(overrides: Partial<AgentStorageUsageSnapshot> = {}): AgentStorageUsageSnapshot {
  return {
    canonicalBytes: 12 * MiB,
    cacheBytes: 4 * MiB,
    totalBytes: 16 * MiB,
    warningBytes: 256 * MiB,
    hardLimitBytes: 512 * MiB,
    isWarning: false,
    isAtHardLimit: false,
    sessionCount: 2,
    messageCount: 18,
    artifactCount: 3,
    canonicalArtifactCount: 0,
    cacheArtifactCount: 3,
    browser: {
      usageBytes: 20 * MiB,
      quotaBytes: 2 * 1_024 * MiB,
    },
    ...overrides,
  };
}

function renderPanel(overrides: Partial<ComponentProps<typeof AgentStoragePanel>> = {}) {
  const props: ComponentProps<typeof AgentStoragePanel> = {
    usage: usage(),
    loading: false,
    clearBusy: false,
    error: null,
    notice: null,
    onRefresh: vi.fn(),
    onClearToolCache: vi.fn(),
    ...overrides,
  };
  const container = mountReact(<AgentStoragePanel {...props} />, mountedRoots);
  return { container, props };
}

afterEach(() => {
  cleanupMountedRootsAndBody(mountedRoots);
});

describe("AgentStoragePanel", () => {
  it("shows bounded Agent usage separately from the extension browser estimate", () => {
    const { container } = renderPanel();

    expect(container.textContent).toContain("Conversation data");
    expect(container.textContent).toContain(
      "The latest completed or cancelled Organize result is stored separately",
    );
    expect(container.textContent).toContain("12 MiB");
    expect(container.textContent).toContain("2 conversations · 18 messages");
    expect(container.textContent).toContain("Tool cache");
    expect(container.textContent).toContain("4 MiB");
    expect(container.textContent).toContain("3 stored tool results");
    expect(container.textContent).toContain("512 MiB local limit");
    expect(container.textContent).toContain("Extension browser storage estimate: 20 MiB of 2 GiB");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax"))
      .toBe(String(512 * MiB));
  });

  it("renders loading and unavailable-estimate states without inventing browser usage", () => {
    const loading = renderPanel({ usage: null, loading: true });
    expect(loading.container.textContent).toContain("Checking Agent storage");
    cleanupMountedRootsAndBody(mountedRoots);

    const unavailable = renderPanel({
      usage: usage({ browser: { usageBytes: null, quotaBytes: null } }),
    });
    expect(unavailable.container.textContent)
      .toContain("Extension browser storage estimate unavailable");
    expect(unavailable.container.textContent).not.toContain("--");
  });

  it.each([
    [256, true, false, "above the warning level"],
    [512, true, true, "reached its local limit"],
  ] as const)(
    "shows the expected capacity state at %i MiB",
    (totalMiB, isWarning, isAtHardLimit, expected) => {
      const { container } = renderPanel({
        usage: usage({
          totalBytes: totalMiB * MiB,
          isWarning,
          isAtHardLimit,
        }),
      });

      expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
    },
  );

  it("clears cache once, reports parent status, and disables cleanup when no cache remains", async () => {
    let resolveClear: (() => void) | undefined;
    const onClearToolCache = vi.fn(() => new Promise<void>((resolve) => {
      resolveClear = resolve;
    }));
    const { container } = renderPanel({ onClearToolCache });
    const clearButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Clear tool cache"));
    expect(clearButton).toBeDefined();

    act(() => {
      clearButton!.click();
      clearButton!.click();
    });
    expect(onClearToolCache).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveClear?.();
      await Promise.resolve();
    });

    cleanupMountedRootsAndBody(mountedRoots);
    const cleared = renderPanel({
      usage: usage({ cacheBytes: 0, artifactCount: 0, cacheArtifactCount: 0 }),
      notice: "Cleared 3 cached results and freed 4 MiB.",
    });
    const disabledClear = [...cleared.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Clear tool cache"));
    expect(disabledClear?.disabled).toBe(true);
    expect(cleared.container.querySelector('[role="status"]')?.textContent)
      .toContain("freed 4 MiB");
  });

  it("keeps errors actionable and retries the isolated usage request", async () => {
    const onRefresh = vi.fn();
    const { container } = renderPanel({
      usage: null,
      error: "Agent storage usage is unavailable: worker unavailable",
      onRefresh,
    });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("worker unavailable");
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Try again");
    await click(retry!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("formats binary storage units without overstating small values", () => {
    expect(formatStorageBytes(0, "en")).toBe("0 B");
    expect(formatStorageBytes(1_536, "en")).toBe("1.5 KiB");
    expect(formatStorageBytes(Number.NaN, "en")).toBe("0 B");
  });
});
