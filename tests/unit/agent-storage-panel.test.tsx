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
  it("exposes accessible storage relationships and capacity semantics", () => {
    const { container } = renderPanel();

    const panel = container.querySelector("section");
    expect(panel?.getAttribute("aria-labelledby")).toBe("agent-storage-heading");
    expect(panel?.getAttribute("aria-describedby"))
      .toBe("agent-storage-intro agent-storage-organize-retention");
    expect(container.querySelector("#agent-storage-heading")).not.toBeNull();
    expect(container.querySelector("#agent-storage-intro")).not.toBeNull();
    expect(container.querySelector("#agent-storage-organize-retention")).not.toBeNull();

    const progress = container.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute("aria-label")).not.toBeNull();
    expect(progress?.getAttribute("aria-describedby"))
      .toBe("agent-storage-thresholds agent-storage-browser-estimate");
    expect(progress?.getAttribute("aria-valuemax")).toBe(String(512 * MiB));
    expect(container.querySelector("#agent-storage-thresholds")).not.toBeNull();
    expect(container.querySelector("#agent-storage-browser-estimate")).not.toBeNull();

    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-describedby="agent-storage-clear-hint"]',
    );
    expect(clearButton).not.toBeNull();
    expect(container.querySelector("#agent-storage-clear-hint")).not.toBeNull();
    expect(container.querySelectorAll("dl dd")).toHaveLength(6);
  });

  it("renders loading and unavailable-estimate states without inventing browser usage", () => {
    const loading = renderPanel({ usage: null, loading: true });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanupMountedRootsAndBody(mountedRoots);

    const unavailable = renderPanel({
      usage: usage({ browser: { usageBytes: null, quotaBytes: null } }),
    });
    const estimate = unavailable.container.querySelector("#agent-storage-browser-estimate");
    expect(estimate?.textContent?.trim()).toBeTruthy();
  });

  it.each([
    [256, true, false, "border-warning/40"],
    [512, true, true, "border-destructive/40"],
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

      expect(container.querySelector('[role="alert"]')?.classList.contains(expected)).toBe(true);
    },
  );

  it("clears the tool cache once, reports parent status, and disables cleanup when no cache remains", async () => {
    let resolveClear: (() => void) | undefined;
    const onClearToolCache = vi.fn(() => new Promise<void>((resolve) => {
      resolveClear = resolve;
    }));
    const { container } = renderPanel({ onClearToolCache });
    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-describedby="agent-storage-clear-hint"]',
    );
    expect(clearButton).not.toBeNull();

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
      notice: "Cleared 3 cached tool artifacts and freed 4 MiB.",
    });
    const disabledClear = cleared.container.querySelector<HTMLButtonElement>(
      'button[aria-describedby="agent-storage-clear-hint"]',
    );
    expect(disabledClear?.disabled).toBe(true);
    expect(cleared.container.querySelector('[role="status"]')).not.toBeNull();
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
    const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button');
    await click(retry!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("formats binary storage units without overstating small values", () => {
    expect(formatStorageBytes(0, "en")).toBe("0 B");
    expect(formatStorageBytes(1_536, "en")).toBe("1.5 KiB");
    expect(formatStorageBytes(Number.NaN, "en")).toBe("0 B");
  });
});
