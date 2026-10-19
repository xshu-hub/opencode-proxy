import {ApiError} from './protocol.mjs';
import {assertSchema} from './schema.mjs';

// DeepSeek's internal tool syntax sometimes escapes provider parsing as text.
// Recover whole call batches on their own line, outside quoted/code examples.
const tokens=['｜DSML｜','｜｜DSML｜｜','|DSML|','||DSML||'];
const markers = tokens.map((token) => '<' + token);
const illustrative = [
  /^\s*(?:examples?|samples?|snippets?|illustrations?)\b|\b(?:examples?|samples?|snippets?|illustrations?)\s*[:：]?\s*$/i,
  /\b(?:example|sample|snippet|illustration|syntax|markup|literal|dsml)\b[^.!?]*[:：]\s*$/i,
  /\b(?:for example|for instance|as an example)\b/i,
  /\b(?:here is|here are|here's|the following)\s+(?:an? |the )?(?:example|sample|snippet|illustration)\b/i,
  /\b(?:this|following|literal)\s+(?:syntax|markup)\b/i,
  /(?:do not|don't|never)\s+(?:execute|run|call)|不要(?:执行|运行|调用)/i,
  /(?:示例|样例|例子|演示|引用|字面|语法|格式)(?:如下|为[:：]?|[:：])|(?:下面|以下|这里)[^。！？]*(?:示例|样例|例子|演示|引用|代码|字面|语法|格式)|(?:例如|比如)[：:\s]?/
];
const invalid=()=>new ApiError('OpenCode returned malformed or incomplete DSML tool calls.',502,null,'invalid_dsml_tool_call');
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function parse(text,definitions){
  let position=0;
  const take=pattern=>{const match=new RegExp('\\s*(?:'+pattern+')','y');match.lastIndex=position;const found=match.exec(text);if(!found)throw invalid();position=match.lastIndex;return found;};
  const root=take('<('+tokens.map(escape).join('|')+')\\s*(calls|tool_calls|function_calls)>');
  const token=escape(root[1]),end='</'+token+'\\s*';
  const calls=[];
  while(!new RegExp('^\\s*'+end+root[2]+'>').test(text.slice(position))){
    if(calls.length>=128)throw invalid();
    const name=take('<'+token+'\\s*invoke\\s+name="([^"<>]+)"\\s*>')[1];
    const definition=definitions.get(name);
    if(!definition)throw new ApiError('OpenCode DSML attempted an unregistered tool.',502,null,'unregistered_tool');
    const input=Object.create(null);
    while(!new RegExp('^\\s*'+end+'invoke>').test(text.slice(position))){
      const parameter=take('<'+token+'\\s*parameter\\s+name="([^"<>]+)"\\s+string="(true|false)"\\s*>');
      if(Object.hasOwn(input,parameter[1]))throw invalid();
      const close=new RegExp(end+'parameter>','g');close.lastIndex=position;const found=close.exec(text);if(!found)throw invalid();
      const raw=text.slice(position,found.index);position=close.lastIndex;
      try{input[parameter[1]]=parameter[2]==='true'?raw:JSON.parse(raw);}catch{throw invalid();}
    }
    take(end+'invoke>');
    try{assertSchema(definition.parameters??{type:'object'},input,'tools');}catch(error){if(error.status===400)throw invalid();throw error;}
    calls.push({ name: definition.name, input });
  }
  take(end+root[2]+'>');
  if(!calls.length||text.slice(position).trim())throw invalid();
  return calls;
}

export class ToolTextRecovery {
  constructor(definitions, { limit = 1024 * 1024 } = {}) {
    this.definitions = new Map(definitions.map((d) => [d.name, d]));
    const ambiguous = new Set();
    for (const definition of definitions)
      for (const alias of definition.aliases ?? []) {
        const previous = this.definitions.get(alias);
        if (previous && previous.name !== definition.name) ambiguous.add(alias);
        else this.definitions.set(alias, definition);
      }
    for (const alias of ambiguous) this.definitions.delete(alias);
    this.mode = definitions.length ? 'probe' : 'text';
    this.pending = '';
    this.limit = limit;
    this.lineStart = true;
    this.lineHead = '';
    this.lineOverflow = false;
    this.paragraphBreak = true;
    this.example = false;
  }
  note(char) {
    if (char !== '\n') {
      if (this.lineHead.length < 4096) this.lineHead += char;
      else this.lineOverflow = true;
      return;
    }
    const line = this.lineHead,
      trimmed = line.trim(),
      fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    // Beyond the context bound we cannot reliably classify an unfinished quote
    // or fence delimiter, so subsequent markup stays literal for this response.
    if (this.lineOverflow) this.literalRemainder = true;
    if (this.fence) {
      if (
        !this.lineOverflow &&
        fence &&
        fence[1][0] === this.fence.char &&
        fence[1].length >= this.fence.length &&
        !line.slice(fence[0].length).trim()
      )
        this.fence = undefined;
    } else if (fence && !this.inlineTicks) this.fence = { char: fence[1][0], length: fence[1].length };
    else if (trimmed) {
      for (const match of line.matchAll(/`+/g)) {
        if (this.inlineTicks === match[0].length) this.inlineTicks = undefined;
        else if (!this.inlineTicks) this.inlineTicks = match[0].length;
      }
      // Ambiguous illustrative prose is deliberately left as text. Carry the
      // hint across wrapped lines and blank lines before an example block.
      const quoted = /^\s*(?:"[^"]*|'[^']*|“[^”]*|‘[^’]*|「[^」]*|『[^』]*)$/.test(line);
      const example =
        illustrative.some((hint) => hint.test(line)) ||
        quoted ||
        /^\s*(?:>|<(?:pre|code|blockquote)(?:\s|>))/i.test(line);
      this.example = (this.paragraphBreak ? false : this.example) || example;
      this.paragraphBreak = false;
    } else this.paragraphBreak = true;
    this.lineHead = '';
    this.lineOverflow = false;
    this.lineStart = true;
  }
  checkLimit() {
    if (Buffer.byteLength(this.pending) > this.limit)
      throw new ApiError('OpenCode DSML tool batch exceeds the recovery limit.', 502, null, 'invalid_dsml_tool_call');
  }
  push(delta) {
    if (this.mode === 'text' || this.literalRemainder) return delta;
    if (this.mode === 'calls') {
      this.pending += delta;
      this.checkLimit();
      return '';
    }
    let output = '';
    for (let i = 0; i < delta.length; i++) {
      const char = delta[i],
        probe = this.lineStart && !this.fence && !this.inlineTicks && !this.example && !this.literalRemainder;
      this.note(char);
      if (!probe) {
        output += char;
        if (char !== '\n') this.lineStart = false;
        continue;
      }
      this.pending += char;
      const start = this.pending.replace(/^ {0,3}/, '');
      if (markers.some((marker) => start.startsWith(marker))) {
        this.mode = 'calls';
        this.pending += delta.slice(i + 1);
        this.checkLimit();
        return output;
      }
      if (char === '\n' || !markers.some((marker) => marker.startsWith(start))) {
        output += this.pending;
        this.pending = '';
        if (char !== '\n') this.lineStart = false;
      }
    }
    return output;
  }
  finish() {
    if (this.mode === 'calls') return { calls: parse(this.pending, this.definitions) };
    const text = this.pending;
    this.pending = '';
    return { text };
  }
}
