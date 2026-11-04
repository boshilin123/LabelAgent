/** 已压缩会话的只读原文回查；不把历史工具记录重新变成可执行调用。 */
export interface HistoryRecallRequest {
  userId: string;
  sessionId: string;
  upToMessageId: string;
  query: string;
}

export interface HistoryRecallMessage {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  truncated: boolean;
}

export interface HistoryRecallTurn {
  turn: number;
  score: number;
  messages: HistoryRecallMessage[];
  omittedMessages?: number;
}

export interface HistoryRecallResult {
  sessionId: string;
  upToMessageId: string;
  turns: HistoryRecallTurn[];
  explicitReference: boolean;
}

export interface HistoryQuery {
  ids: string[];
  turns: number[];
  terms: string[];
  explicitReference: boolean;
}

const STOP_WORDS = new Set([
  '之前',
  '以前',
  '当时',
  '上次',
  '我们',
  '你们',
  '这个',
  '那个',
  '什么',
  '多少',
  '怎么',
  '哪个',
  '是否',
  '已经',
  '确定',
  '具体',
  '请问',
  '告诉',
  '回答',
  '一下',
  '使用',
  '设置',
  '记得',
  '历史',
  '会话',
  '消息',
  '原文',
  '内容',
  '可以',
  '需要',
  'the',
  'what',
  'was',
  'were',
  'did',
  'you',
  'our',
  'and',
  'that',
  'this',
  'please',
  'earlier',
  'previous',
  'previously',
  'history',
  'message',
  'recall',
  'remember',
]);

function chineseNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits = '零一二三四五六七八九';
  let result = 0;
  let current = 0;
  for (const char of raw.replace(/两/g, '二')) {
    const digit = digits.indexOf(char);
    if (digit >= 0) current = digit;
    else if (char === '十') {
      result += (current || 1) * 10;
      current = 0;
    } else if (char === '百') {
      result += (current || 1) * 100;
      current = 0;
    } else return 0;
  }
  return result + current;
}

/** 有明确 ID/轮次时精确定位，否则提取少量中文短词和英文标识符。 */
export function parseHistoryQuery(input: string): HistoryQuery {
  const query = String(input ?? '')
    .slice(0, 8_000)
    .normalize('NFKC');
  const ids = Array.from(
    query.matchAll(
      /(?:消息\s*(?:id|ID|编号)|message\s*id)\s*[:：=]?\s*[`"']?([\w-]{1,128})/gi,
    ),
    (match) => match[1],
  );
  for (const match of query.matchAll(
    /\b(?:[a-z]+-)?[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,
  ))
    ids.push(match[0]);
  for (const match of query.matchAll(
    /\b(?:msg|message|user|assistant|agent)-[a-z0-9]+-[a-z0-9]+\b/gi,
  ))
    ids.push(match[0]);
  const turns = Array.from(
    query.matchAll(
      /第\s*([\d零一二三四五六七八九十百两]+)\s*(?:轮|回合)|\bturn\s*#?\s*(\d+)/gi,
    ),
    (match) => chineseNumber(match[1] ?? match[2]),
  ).filter((n) => n > 0 && n <= 100_000);
  let stripped = query
    .toLowerCase()
    .replace(/第\s*[\d零一二三四五六七八九十百两]+\s*(?:轮|回合)/g, ' ');
  for (const word of STOP_WORDS)
    if (/^[\u3400-\u9fff]+$/.test(word))
      stripped = stripped.split(word).join(' ');
  const terms: string[] = [];
  for (const match of stripped.matchAll(
    /[a-z0-9_][a-z0-9_./\\:-]{1,95}|[\u3400-\u9fff]{2,}/g,
  )) {
    const token = match[0].replace(/[?.,:;]+$/, '');
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      if (token.length <= 8) terms.push(token);
      for (let i = 0; i < token.length - 1; i += 1)
        terms.push(token.slice(i, i + 2));
    } else if (!STOP_WORDS.has(token)) {
      terms.push(token);
      const basename = token.split(/[/\\]/).pop();
      if (basename && basename !== token && basename.length > 1)
        terms.push(basename);
    }
  }
  return {
    ids: [...new Set(ids)].slice(0, 8),
    turns: [...new Set(turns)].slice(0, 4),
    terms: [...new Set(terms)]
      .filter((word) => !STOP_WORDS.has(word))
      .slice(0, 32),
    explicitReference:
      ids.length > 0 ||
      turns.length > 0 ||
      /之前|以前|当时|上次|早先|历史|原文|\b(?:earlier|previous|recall|remember)\b/i.test(
        query,
      ),
  };
}

/** 提取可作为证据的保存内容；跳过推理块和瞬态状态。 */
export function historyTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .flatMap((block: Record<string, unknown>) => {
      if (!block || typeof block !== 'object') return [];
      if (block.type === 'text')
        return typeof block.content === 'string' ? [block.content] : [];
      if (block.type === 'tool_call')
        return [
          JSON.stringify({
            historicalTool: block.name,
            arguments: block.arguments,
            result: block.result,
          }),
        ];
      if (block.type === 'file_proposal' || block.type === 'document_proposal')
        return [
          JSON.stringify({
            historicalProposal: block.title,
            path: block.suggestedRelativePath,
            oldPath: block.oldPath,
            operation: block.operation,
            status: block.status,
            content: block.content,
          }),
        ];
      if (block.type === 'subagent' && typeof block.summary === 'string')
        return [block.summary];
      return [];
    })
    .join('\n');
}

/** 长消息保留关键词附近原文；截断会显式标记，不伪装成完整记录。 */
export function historyExcerpt(
  text: string,
  terms: string[],
  maxChars: number,
): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  const found =
    [...terms]
      .sort((a, b) => b.length - a.length)
      .map((term) => lower.indexOf(term.toLowerCase()))
      .find((index) => index >= 0) ?? 0;
  let start = Math.max(
    0,
    Math.min(found - Math.floor(maxChars / 4), text.length - maxChars),
  );
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1;
  let end = start + maxChars;
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end -= 1;
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
