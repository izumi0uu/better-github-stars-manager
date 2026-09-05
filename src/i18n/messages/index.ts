import type { Locale } from '@/types';

import {
  type CommonMessages,
  enCommonMessages,
  zhCommonMessages,
} from './common';
import {
  type DevMessages,
  enDevMessages,
  zhDevMessages,
} from './dev';
import {
  type ManagerMessages,
  enManagerMessages,
  zhManagerMessages,
} from './manager';
import {
  type WatchMessages,
  enWatchMessages,
  zhWatchMessages,
} from './watch';
import {
  type RadarMessages,
  enRadarMessages,
  zhRadarMessages,
} from './radar';
import {
  type ToolbarMessages,
  enToolbarMessages,
  zhToolbarMessages,
} from './toolbar';
import {
  type AgentPanelMessages,
  enAgentPanelMessages,
  zhAgentPanelMessages,
} from './agent-panel';
import {
  type ActiveFilterMessages,
  enActiveFilterMessages,
  zhActiveFilterMessages,
} from './active-filters';
import {
  type FilterSidebarMessages,
  enFilterSidebarMessages,
  zhFilterSidebarMessages,
} from './filter-sidebar';
import {
  type StarRowMessages,
  enStarRowMessages,
  zhStarRowMessages,
} from './star-row';
import {
  type RepoDetailMessages,
  enRepoDetailMessages,
  zhRepoDetailMessages,
} from './repo-detail';
import {
  type TagEditorMessages,
  enTagEditorMessages,
  zhTagEditorMessages,
} from './tag-editor';
import {
  type PopupMessages,
  enPopupMessages,
  zhPopupMessages,
} from './popup';
import {
  type OptionsMessages,
  enOptionsMessages,
  zhOptionsMessages,
} from './options';
import {
  type RepoChipMessages,
  enRepoChipMessages,
  zhRepoChipMessages,
} from './repo-chip';
import {
  type BackgroundMessages,
  enBackgroundMessages,
  zhBackgroundMessages,
} from './background';
import {
  type ErrorMessages,
  enErrorMessages,
  zhErrorMessages,
} from './errors';
import {
  type OnboardingMessages,
  enOnboardingMessages,
  zhOnboardingMessages,
} from './onboarding';

export type { WatchStatusProgressField, WatchStatusTextPart } from './watch';

export interface MessageCatalog {
  localeName: string;
  common: CommonMessages;
  dev: DevMessages;
  manager: ManagerMessages;
  watch: WatchMessages;
  radar: RadarMessages;
  toolbar: ToolbarMessages;
  agentPanel: AgentPanelMessages;
  activeFilters: ActiveFilterMessages;
  filterSidebar: FilterSidebarMessages;
  starRow: StarRowMessages;
  repoDetail: RepoDetailMessages;
  tagEditor: TagEditorMessages;
  popup: PopupMessages;
  options: OptionsMessages;
  repoChip: RepoChipMessages;
  background: BackgroundMessages;
  /** Humanized error strings. Keys are matched against stable error codes thrown
   *  across the codebase (see src/api/errors.ts). `unknown` is the passthrough —
   *  it keeps the raw tail so nothing is silently swallowed. */
  errors: ErrorMessages;
  /** First-run onboarding card (ManagerPanel). Context-aware: shows until the
   *  user dismisses it with "Got it" (sets Config.seenOnboarding). */
  onboarding: OnboardingMessages;
}

export const messages: Record<Locale, MessageCatalog> = {
  en: {
    localeName: "English",
    common: enCommonMessages,
    dev: enDevMessages,
    manager: enManagerMessages,
    watch: enWatchMessages,
    radar: enRadarMessages,
    toolbar: enToolbarMessages,
    agentPanel: enAgentPanelMessages,
    activeFilters: enActiveFilterMessages,
    filterSidebar: enFilterSidebarMessages,
    starRow: enStarRowMessages,
    repoDetail: enRepoDetailMessages,
    tagEditor: enTagEditorMessages,
    popup: enPopupMessages,
    options: enOptionsMessages,
    repoChip: enRepoChipMessages,
    background: enBackgroundMessages,
    errors: enErrorMessages,
    onboarding: enOnboardingMessages,
  },
  "zh-CN": {
    localeName: "中文",
    common: zhCommonMessages,
    dev: zhDevMessages,
    manager: zhManagerMessages,
    watch: zhWatchMessages,
    radar: zhRadarMessages,
    toolbar: zhToolbarMessages,
    agentPanel: zhAgentPanelMessages,
    activeFilters: zhActiveFilterMessages,
    filterSidebar: zhFilterSidebarMessages,
    starRow: zhStarRowMessages,
    repoDetail: zhRepoDetailMessages,
    tagEditor: zhTagEditorMessages,
    popup: zhPopupMessages,
    options: zhOptionsMessages,
    repoChip: zhRepoChipMessages,
    background: zhBackgroundMessages,
    errors: zhErrorMessages,
    onboarding: zhOnboardingMessages,
  },
};
