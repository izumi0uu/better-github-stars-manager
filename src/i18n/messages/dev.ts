export type DevMessages = {
  version: (hash: string) => string;
  clearLocalData: string;
  confirmClearLocalData: string;
  clearingLocalData: string;
  clearLocalDataFailed: (error: string) => string;
};

export const enDevMessages: DevMessages = {
  version: (hash) => `DEV ${hash}`,
  clearLocalData: "Clear local",
  confirmClearLocalData: "Confirm clear",
  clearingLocalData: "Clearing…",
  clearLocalDataFailed: (error) => `Clear failed: ${error}`,
};

export const zhDevMessages: DevMessages = {
  version: (hash) => `DEV ${hash}`,
  clearLocalData: "清本地",
  confirmClearLocalData: "确认清除",
  clearingLocalData: "清除中…",
  clearLocalDataFailed: (error) => `清除失败: ${error}`,
};
