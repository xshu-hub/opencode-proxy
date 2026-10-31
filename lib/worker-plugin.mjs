import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, clientToolNames, toolPermissions, toNativeHistory } from './protocol.mjs';
import { applyReasoning, applyThinking } from './reasoning.mjs';
import {nativeGeneration} from './generation.mjs';
import {sharedSessions} from './shared-sessions.mjs';

// Also retire a warm child if the plugin host is forcibly terminated.
const parentPID = Number(process.env.OPENCODE_PROXY_PARENT_PID);
if (Number.isInteger(parentPID) && parentPID > 0) {
  const watch = setInterval(() => { try { process.kill(parentPID, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(0); } }, 2000);
  watch.unref?.();
}

// This is loaded through OpenCode's public plugin config, without patching OpenCode.
export const BridgeWorker = async ({ directory, worktree=directory }) => {
  const shared = process.env.OPENCODE_PROXY_SHARED_ROOT;
  const sessions=shared?await sharedSessions(shared,directory):undefined;
  if(sessions)await writeFile(path.join(shared,'instance-ready.json'),JSON.stringify({directory:await realpath(directory),worktree:await realpath(worktree),cwd:await realpath(process.cwd()),groupID:sessions.group.groupID}),{mode:0o600});
  const single={injected:false,systemTransformed:false,stopped:Promise.withResolvers()};
  const get=async id=>{
    if(sessions)return sessions.get(id);
    single.request??=JSON.parse(await readFile(process.env.OPENCODE_PROXY_REQUEST,'utf8'));
    return single;
  };
  return {
    ...(sessions?{
      dispose:()=>sessions.dispose(),
      event:async({event})=>{if(event.type==='session.deleted'){try{await sessions.release(event.properties?.info?.id);}catch{/* Missing acknowledgement quarantines the process at the proxy. */}}},
    }:{}),
    config: async cfg => {
      // The final public plugin hook limits only this transient API worker.
      // Existing provider configuration and auth hooks remain intact.
      const permission = sessions?sessions.group.contract.permission:toolPermissions((await get()).request.body);
      cfg.permission = permission;
      cfg.agent ??= {};
      cfg.agent.bridge = { mode: 'primary', prompt: 'Follow the client instructions.', permission };
      cfg.agent.title = { disable: true };
      cfg.snapshot = false;
      cfg.autoupdate = false;
      cfg.share = 'disabled';
      // These are discarded by our prompt hook anyway. Do not fetch remote
      // rules or skill catalogs before reaching that hook.
      cfg.instructions = [];
      cfg.skills = { paths: [], urls: [] };
      if (sessions) {
        cfg.mcp ??= {};
        cfg.mcp.bridge = { type: 'remote', url: sessions.group.mcpURL, oauth: false, timeout: sessions.group.mcpTimeout };
      }
      for (const name of Object.keys(cfg.mcp ?? {})) if (name !== 'bridge') cfg.mcp[name] = { ...cfg.mcp[name], enabled: false };
    },
    'tool.execute.before': async ({ tool, sessionID }) => {
      const {request:{body}}=await get(sessionID);
      if (!(tool==='StructuredOutput'&&nativeGeneration(body))&&!clientToolNames(body).includes(tool)) throw new ApiError('OpenCode attempted an unregistered local tool.', 502, null, 'unregistered_tool');
    },
    'experimental.chat.messages.transform': async (_, output) => {
      const sessionID=output.messages[0]?.info.sessionID;
      if(sessions&&output.messages.some(m=>m.info.sessionID!==sessionID))throw new Error('Mixed OpenCode session history.');
      const state=await get(sessionID),r=state.request;
      // The standard SDK must settle MCP deferral acknowledgements to publish
      // finish-step. Gate any continuation before another inference can start.
      if (state.injected) { if (sessions) { await state.stopped.promise;throw new Error('OpenCode continuation was cancelled.'); } await new Promise(() => {}); }
      state.injected = true;
      const selected = output.messages[0].info.model;
      output.messages.splice(0, output.messages.length, ...toNativeHistory(r.body, sessionID, r.modelID ?? selected.modelID, directory, r.providerID ?? selected.providerID, worktree).messages);
    },
    'experimental.chat.system.transform': async (input, output) => {
      const state=await get(input.sessionID),r=state.request;
      output.system.splice(0, output.system.length, ...toNativeHistory(r.body, '', r.modelID, directory).system);
      const generation=nativeGeneration(r.body);
      if(generation){const tool=generation.capture?'bridge_structured_output':'StructuredOutput';output.system.push(generation.kind==='json'?'You MUST return the requested final JSON by calling '+tool+'. Do not return JSON as ordinary answer text.':'You MUST call '+tool+' to return the selected client function calls and their arguments in calls[]. Do not execute client functions. For an ordinary answer without a function call use calls=[] and answer.');}
      state.systemTransformed = true;
    },
    'chat.params': async (input, output) => {
      const state=await get(input.sessionID);
      const { body, outputLimit, global, hookFile, reasoningVariants } = state.request;
      if (!state.injected || !state.systemTransformed) throw new Error('OpenCode did not invoke the required message and system transformation hooks.');
      if (global && (input.model.providerID === 'opencode-bridge' || input.model.id.startsWith('opencode-bridge/'))) throw new Error('OpenCode points back to this bridge. Select an upstream model in OpenCode.');
      if (body.temperature !== undefined) output.temperature = body.temperature;
      if (body.top_p !== undefined) output.topP = body.top_p;
      if (body.top_k !== undefined) output.topK = body.top_k;
      try {
        const requested = body.max_completion_tokens ?? body.max_tokens;
        if (requested !== undefined && input.model.limit.output > 0 && requested > input.model.limit.output) throw new ApiError(`Requested output tokens (${requested}) exceed the OpenCode model limit (${input.model.limit.output}).`, 400, body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens');
        output.maxOutputTokens = requested ?? Math.min(outputLimit, input.model.limit.output || outputLimit);
        output.options = applyReasoning(input.model, output.options, body.reasoning_effort, reasoningVariants);
        output.options = applyThinking(input.model, output.options, body.thinking, body.reasoning_effort, reasoningVariants, output.maxOutputTokens);
      } catch (error) {
        if (error instanceof ApiError) await writeFile(hookFile, JSON.stringify({ error: { status: error.status, ...error.body().error } }), { mode: 0o600 });
        throw error;
      }
      await writeFile(hookFile, JSON.stringify({ history: true, system: true, params: true, sessionID:input.sessionID, directory,worktree,pid:process.pid }), { mode: 0o600 });
      // Provider defaults may still add vendor-specific options; request fields are never invented.
    },
  };
};
