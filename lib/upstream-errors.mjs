import {ApiError} from './protocol.mjs';

// OpenCode owns supplier execution and retries. Preserve only public error data.
export function upstreamError(error,code='opencode_inference_error') {
  if(error instanceof ApiError)return error;
  const data=error?.data??{},message=typeof data.message==='string'?data.message:'OpenCode inference failed.';
  let status=Number.isInteger(data.statusCode)&&data.statusCode>=400&&data.statusCode<=599?data.statusCode:502;
  if(error?.name==='ContextOverflowError')status=400;
  if(error?.name==='ProviderAuthError')status=401;
  const result=new ApiError(message,status,null,status===429?'upstream_rate_limit':status===401||status===403?'upstream_auth_error':error?.name==='ContextOverflowError'?'context_length_exceeded':code);
  const retry=Object.entries(data.responseHeaders??{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1];
  if(typeof retry==='string'&&retry.length<=128&&!/[\r\n]/.test(retry)&&(/^[0-9]+(?:\.[0-9]+)?$/.test(retry)||Number.isFinite(Date.parse(retry))))result.headers={'retry-after':retry};
  return result;
}

export function retryError(status,afterOutput=true) {
  const limited=/\b429\b|rate.?limit|too many requests/i.test(status?.message??'');
  const error=new ApiError(afterOutput?(limited?'Upstream rate limited after output began; retry the request.':'OpenCode attempted to retry after output began; retry the request.'):'OpenCode upstream retry budget exhausted; retry the request later.',limited?429:afterOutput?502:503,null,limited?'upstream_rate_limit':afterOutput?'opencode_retry_after_output':'opencode_retry_exhausted');
  if(Number.isFinite(status?.next))error.headers={'retry-after':String(Math.max(1,Math.ceil((status.next-Date.now())/1000)))};
  return error;
}
