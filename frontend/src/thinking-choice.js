// Preserve existing advanced settings while presenting ordinary choices.
export function initialThinkingChoice(model,override={}){
  const preset=structuredClone(override.reasoningPreset??{type:'native'}),legacy=override.reasoningVariants??{},levels=Object.keys(legacy);
  let preserveLegacy=!override.reasoningPreset&&levels.length>0;
  if(preserveLegacy&&model.reasoningAdapter==='effort'&&levels.every(e=>Object.keys(legacy[e]).length===1&&legacy[e].reasoningEffort===e))return{preset:{type:'effort',levels},preserveLegacy:false};
  return{preset,preserveLegacy};
}
