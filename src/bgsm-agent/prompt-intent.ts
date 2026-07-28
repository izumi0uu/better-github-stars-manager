const CODE_SEARCH_INTENT =
  /(?:\b(?:codes?|(?<!open[-\s])sources?|implementations?|functions?|class(?:es)?|methods?|files?|director(?:y|ies)|folders?|trees?|contents?|paths?)\b[^.!?\n]{0,80}\b(?:search|find|inspect|read|look|show|list|browse|open)\b|\b(?:search|find|inspect|read|look|show|list|browse|open)\b[^.!?\n]{0,80}\b(?:codes?|(?<!open[-\s])sources?|implementations?|functions?|class(?:es)?|methods?|files?|director(?:y|ies)|folders?|trees?|contents?|paths?)\b)/i;
const CHINESE_CODE_SEARCH_INTENT =
  /(?:搜索|查找|查看|检查|读取|列出|浏览|打开)[^。！？\n]{0,32}(?:代码|源码|实现|函数|类|方法|文件|目录|文件树|路径)|(?:代码|源码|实现|函数|类|方法|文件|目录|文件树|路径)[^。！？\n]{0,32}(?:搜索|查找|查看|检查|读取|列出|浏览|打开)/;
const DIRECT_CODE_ARTIFACT_INTENT =
  /(?:\b(?:open(?![-\s]+source\b)|read|show|inspect|search|find|list|browse)\b|(?:打开|读取|查看|检查|搜索|查找|列出|浏览))[^.!?。！？\n]{0,80}(?:(?:[\p{L}\p{N}_@.-]+\/){2,}[\p{L}\p{N}_@.-]+\.(?:[cm]?[jt]sx?|json|mdx?|ya?ml|toml|css|scss|html?|py|go|rs|java|kt|kts|rb|php|sh|sql|graphql|vue|svelte|lock|txt)|(?<![\p{L}\p{N}_@./-])(?:README|Dockerfile|Makefile|LICENSE|CHANGELOG)(?:\.[\p{L}\p{N}_-]+)?|(?<![\p{L}\p{N}_@./-])[\p{L}\p{N}_@-]+\.(?:[cm]?[jt]sx?|json|mdx?|ya?ml|toml|css|scss|html?|py|go|rs|java|kt|kts|rb|php|sh|sql|graphql|vue|svelte|lock|txt))/iu;
const KNOWN_CODE_ROOT_PATH_INTENT =
  /(?:\b(?:open|read|show|inspect|search|find|list|browse)\b|(?:打开|读取|查看|检查|搜索|查找|列出|浏览))[^.!?。！？\n]{0,80}(?:src|lib|app|apps|packages|test|tests|docs|scripts|config|public|server|client|components)\/(?:[\p{L}\p{N}_@.-]+\/)*[\p{L}\p{N}_@.-]+\.(?:[cm]?[jt]sx?|json|mdx?|ya?ml|toml|css|scss|html?|py|go|rs|java|kt|kts|rb|php|sh|sql|graphql|vue|svelte|lock|txt)/iu;
const SYMBOL_LOCATION_INTENT =
  /\bwhere\s+(?:is|are)\s+[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)?\s+(?:defined|declared|implemented)\b|[$A-Z_a-z][$\w]{2,}[^。！？\n]{0,24}(?:在哪里|哪儿|何处)(?:定义|声明|实现)/iu;
const ENGLISH_NOTES_INTENT =
  /(?:\b(?:read|show|find|search|check|inspect|use|summarize|review|from|based on|according to|what(?:'s| is| are)?)\b[^.!?\n]{0,96}\b(?:note|notes|annotation|annotations)\b|\b(?:note|notes|annotation|annotations)\b[^.!?\n]{0,96}\b(?:read|show|find|search|check|inspect|use|summarize|review|say|mention)\b)/i;
const CHINESE_NOTES_INTENT =
  /(?:读取|查看|查找|搜索|检查|使用|总结|回顾|根据|按照|参考|看看|是什么)[^。！？\n]{0,40}(?:笔记|备注)|(?:笔记|备注)[^。！？\n]{0,40}(?:读取|查看|查找|搜索|检查|使用|总结|回顾|根据|按照|参考|看看|是什么)/;
const NOTES_READ_NEGATION =
  /(?:\b(?:do\s+not|don(?:['’])?t|never)\b[^.;!?\n]{0,48}\b(?:read|show|use|inspect|summarize)\b[^.;!?\n]{0,32}\b(?:note|notes|annotation|annotations)\b|(?:不要|不可|不能|请勿)[^；。！？\n]{0,24}(?:读取|查看|使用|检查|总结)[^；。！？\n]{0,16}(?:笔记|备注))/iu;

const ENGLISH_TAG_WRITE_PROHIBITION =
  /\bno\s+(?:more\s+)?tagging\b|\bno\s+tag\s+changes?\b|\bno\s+changes?\s+to\s+(?:the\s+)?tags?\b|\b(?:leave|keep)\s+(?:the\s+)?tags?\s+(?:unchanged|as[-\s]?is)\b|\b(?:do\s+not|don(?:['’])?t|never|must\s+not|cannot|can(?:['’])?t|not\s+allowed\s+to)\s+(?:(?:please|ever|directly|accidentally|automatically|permanently|categorically|now|by\s+any\s+means|under\s+any\s+circumstances|want\s+(?:you\s+)?to)\s+){0,4}(?:(?:tag|label|categorize|classify)\b|(?:assign|add|apply|change|modify|write|touch)\b[^,.;!?\n]{0,32}\btags?\b)|\b(?:refrain\s+from|avoid|without)\s+(?:(?:tagging|labeling|categorizing|classifying)\b|(?:assigning|adding|applying|changing|modifying|writing|touching)\b[^,.;!?\n]{0,32}\btags?\b)/iu;
const CHINESE_TAG_WRITE_NEGATOR = /不要|不可|不能|请勿|不得|禁止|切勿|无需|无须|别/gu;
const CHINESE_TAG_WRITE_ACTION =
  /打标|标记|标注|归类|分类|设为|设成|设置为|设置成|分配|添加|打上?|加上?|加个|贴上?|贴个|补上?|补个|写入|应用|修改|改变/gu;
const CHINESE_DIRECT_TAG_WRITE_ACTION =
  /^(?:打标|标记|标注|归类|分类|设为|设成|设置为|设置成)$/u;
const CHINESE_TAG_NOUN_AFTER_ACTION = /^[^，。！？；\n]{0,32}标签/u;
const CHINESE_RELATIVE_REPOSITORY_SCOPE = /的[^，。！？；\n]{0,8}(?:仓库|项目)/u;
const CHINESE_OUTER_SCOPE_BEFORE_NEGATOR =
  /^(?:(?:请|请你|帮我|我想(?:要)?|麻烦(?:你)?)\s*)?(?:给|为|把|将|对|在|向|往|替)[^，。！？；\n]*$/u;
const CHINESE_CLAUSE_BOUNDARY = /[，。！？；\n]+/u;
const CHINESE_UNCHANGED_TAG_PROHIBITION =
  /(?:保持|维持)[^，。！？；\n]{0,16}标签[^，。！？；\n]{0,8}(?:不变|原样)/u;
const REMOVE_OR_DELETE_INTENT =
  /\b(?:remove|unassign|delete)\b|移除|取消标签|删除/i;

export type BgsmPromptCapabilities = Readonly<{
  manualTagWritesForbidden: boolean;
  repositoryCodeSearch: boolean;
  repositoryNotes: boolean;
}>;

export type BgsmPromptIntent = Readonly<{
  capabilities: BgsmPromptCapabilities;
}>;

export function analyzeBgsmPromptIntent(prompt: string): BgsmPromptIntent {
  const value = prompt.trim();
  const repositoryCodeSearch = value.length > 0
    && (
      CODE_SEARCH_INTENT.test(value)
      || CHINESE_CODE_SEARCH_INTENT.test(value)
      || DIRECT_CODE_ARTIFACT_INTENT.test(value)
      || KNOWN_CODE_ROOT_PATH_INTENT.test(value)
      || SYMBOL_LOCATION_INTENT.test(value)
    );
  const repositoryNotes = value.length > 0
    && !NOTES_READ_NEGATION.test(value)
    && (ENGLISH_NOTES_INTENT.test(value) || CHINESE_NOTES_INTENT.test(value));
  const manualTagWritesForbidden = value.length > 0
    && (
      ENGLISH_TAG_WRITE_PROHIBITION.test(value)
      || hasChineseTagWriteProhibition(value)
      || REMOVE_OR_DELETE_INTENT.test(value)
    );
  return Object.freeze({
    capabilities: Object.freeze({
      manualTagWritesForbidden,
      repositoryCodeSearch,
      repositoryNotes,
    }),
  });
}

function hasChineseTagWriteProhibition(value: string): boolean {
  if (CHINESE_UNCHANGED_TAG_PROHIBITION.test(value)) return true;
  return value.split(CHINESE_CLAUSE_BOUNDARY).some((clause) => {
    for (const negator of clause.matchAll(CHINESE_TAG_WRITE_NEGATOR)) {
      const negatorIndex = negator.index ?? 0;
      const beforeNegator = clause.slice(0, negatorIndex);
      const suffix = clause.slice(negatorIndex + negator[0].length);
      const actionIndex = lastChineseTagWriteActionIndex(suffix);
      if (actionIndex < 0) continue;
      const beforeAction = suffix.slice(0, actionIndex);
      const isRepositoryQualifier = CHINESE_RELATIVE_REPOSITORY_SCOPE.test(beforeAction)
        && CHINESE_OUTER_SCOPE_BEFORE_NEGATOR.test(beforeNegator);
      if (!isRepositoryQualifier) return true;
    }
    return false;
  });
}

function lastChineseTagWriteActionIndex(value: string): number {
  let lastIndex = -1;
  for (const action of value.matchAll(CHINESE_TAG_WRITE_ACTION)) {
    const index = action.index ?? -1;
    if (index < 0) continue;
    const isDirect = CHINESE_DIRECT_TAG_WRITE_ACTION.test(action[0]);
    const remainder = value.slice(index + action[0].length);
    if (isDirect || CHINESE_TAG_NOUN_AFTER_ACTION.test(remainder)) lastIndex = index;
  }
  return lastIndex;
}
