// Bucket each tool_use in a segment into one of six operation categories and estimate the
// token cost of its result. The API bills tokens per assistant MESSAGE, not per tool, so a
// tool's real cost — its result text, which lands in the NEXT message's input — is never
// labelled per tool. We approximate it as (matched tool_result payload bytes / 4). Counts are
// exact; est_tokens is an estimate (cache tiering and cross-segment result splits are ignored).

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'ToolSearch']);
const INTERNET_TOOLS = new Set(['WebFetch', 'WebSearch']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const CATEGORIES = ['file', 'search', 'internet', 'mcp', 'shell', 'other'];

// Tool name → category. MCP is matched by the mcp__<server>__<tool> prefix first.
function categoryOf(name) {
  if (typeof name === 'string' && name.startsWith('mcp__')) return 'mcp';
  if (FILE_TOOLS.has(name)) return 'file';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (INTERNET_TOOLS.has(name)) return 'internet';
  if (SHELL_TOOLS.has(name)) return 'shell';
  return 'other';
}

// Byte length of a tool_result's content, tolerating both the string and text-block-array forms.
function resultBytes(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf-8');
  if (Array.isArray(content)) {
    let bytes = 0;
    for (const block of content) {
      const text = typeof block?.text === 'string' ? block.text : null;
      bytes += Buffer.byteLength(text ?? JSON.stringify(block ?? ''), 'utf-8');
    }
    return bytes;
  }
  return 0;
}

// Per-category { count, est_tokens } over a segment's transcript lines. tool_use blocks live on
// assistant lines; their tool_result (matched by tool_use_id) lands on a later user line within
// the same segment, so a two-pass walk resolves the result size for each call.
export function computeOperations(lines) {
  const bytesById = new Map();
  for (const line of lines) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
      bytesById.set(block.tool_use_id, resultBytes(block.content));
    }
  }

  const totals = {};
  for (const cat of CATEGORIES) totals[cat] = { count: 0, est_tokens: 0 };

  for (const line of lines) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const cat = totals[categoryOf(block.name)];
      cat.count += 1;
      cat.est_tokens += Math.round((bytesById.get(block.id) || 0) / 4);
    }
  }

  return totals;
}
