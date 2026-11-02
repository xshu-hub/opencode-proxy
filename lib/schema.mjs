import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {ApiError} from './protocol.mjs';
const ajv=new Ajv({strict:false,strictSchema:true,validateFormats:true,ownProperties:true,addUsedSchema:false});
addFormats(ajv);
const cache=new Map();
export function compileSchema(schema,param='response_format') {
  const key=JSON.stringify(schema);
  if(!schema||typeof schema!=='object'||Array.isArray(schema)||key.length>65536)throw new ApiError('JSON Schema must be an object of at most 64 KiB.',400,param);
  let validate=cache.get(key);if(validate)return validate;
  try{validate=ajv.compile(schema);}catch{throw new ApiError('Invalid or unsupported JSON Schema; references must resolve locally.',400,param);}finally{ajv.removeSchema(schema);}
  if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,validate);return validate;
}
export function assertSchema(schema,value,param='response_format') {
  const validate=compileSchema(schema,param);
  if(!validate(value))throw new ApiError('OpenCode output did not satisfy the requested JSON Schema.',502,param,'invalid_structured_output');
}
