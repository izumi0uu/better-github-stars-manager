import type { Locale } from '@/types';

export type DemoCopy = Readonly<{
  shell: Readonly<{
    skipToContent: string;
    brandName: string;
    publicDemo: string;
    resetDemo: string;
    resetHint: string;
    resetConfirmTitle: string;
    resetConfirmBody: string;
    confirmReset: string;
    cancelReset: string;
    resetting: string;
    resetFailed: string;
    noticeLabel: string;
    noticeTitle: string;
    noticeBody: string;
    syntheticLinkBlocked: string;
    resourceNavigation: string;
    productLinks: string;
    productLinksHint: string;
    install: string;
    source: string;
    privacy: string;
    documentation: string;
  }>;
}>;

const DEMO_COPY: Record<Locale, DemoCopy> = {
  en: {
    shell: {
      skipToContent: 'Skip to demo content',
      brandName: 'Better GitHub Stars Manager',
      publicDemo: 'Public demo',
      resetDemo: 'Reset demo',
      resetHint: 'Restore the synthetic data and every local view to its starting state.',
      resetConfirmTitle: 'Reset the demo?',
      resetConfirmBody: 'All in-memory demo changes and view state will be restored. Nothing on GitHub is affected.',
      confirmReset: 'Reset everything',
      cancelReset: 'Keep exploring',
      resetting: 'Resetting…',
      resetFailed: 'The demo could not be reset. Please try again.',
      noticeLabel: 'Demo data notice',
      noticeTitle: 'Synthetic data · Not connected to GitHub',
      noticeBody: 'This page uses a fixed, fictional library. Changes stay in memory and disappear when you reload.',
      syntheticLinkBlocked: 'Synthetic repository and profile links are intentionally disabled in this public demo.',
      resourceNavigation: 'Product resources',
      productLinks: 'Real product links',
      productLinksHint: 'These allowlisted links leave the synthetic demo and open official product pages.',
      install: 'Install extension',
      source: 'Source',
      privacy: 'Privacy',
      documentation: 'Documentation',
    },
  },
  'zh-CN': {
    shell: {
      skipToContent: '跳到演示内容',
      brandName: 'Better GitHub Stars Manager',
      publicDemo: '公开演示',
      resetDemo: '重置演示',
      resetHint: '将合成数据和所有本地视图恢复到初始状态。',
      resetConfirmTitle: '要重置演示吗？',
      resetConfirmBody: '所有内存中的演示更改和界面状态都会恢复；GitHub 上的内容不会受到影响。',
      confirmReset: '全部重置',
      cancelReset: '继续浏览',
      resetting: '正在重置…',
      resetFailed: '无法重置演示，请重试。',
      noticeLabel: '演示数据说明',
      noticeTitle: '合成数据 · 未连接 GitHub',
      noticeBody: '本页使用固定的虚构资料库。更改只保存在内存中，刷新页面后即会清除。',
      syntheticLinkBlocked: '公开演示已停用合成仓库和用户资料链接，页面不会跳转到 GitHub。',
      resourceNavigation: '产品资源',
      productLinks: '真实产品链接',
      productLinksHint: '以下白名单链接会离开合成演示，并打开官方产品页面。',
      install: '安装扩展',
      source: '源代码',
      privacy: '隐私政策',
      documentation: '文档',
    },
  },
};

export function demoCopyFor(locale: Locale): DemoCopy {
  return DEMO_COPY[locale] ?? DEMO_COPY.en;
}
