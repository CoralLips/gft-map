import {textWidth} from './textWidth';
/** A caption budget shared by model output, manual edits and the input, counted in Chinese-character widths. */
export const RELATION_REASON_LIMIT = 32;
export class RelationReasonLengthError extends Error {
  constructor() { super("\u627f\u63a5\u8bf4\u660e\u6700\u591a 32 \u5b57\uff0c\u8bf7\u53ea\u4fdd\u7559\u4e00\u53e5\u5173\u8054\u5f15\u5165\u3002");this.name='RelationReasonLengthError'; }
}
export function checkedRelationReason(reason:string):string {
  const text=reason.trim();
  if(textWidth(text)>RELATION_REASON_LIMIT)throw new RelationReasonLengthError();
  return text;
}
/** Batch writes (update, tidy) skip a caption over the budget instead of failing the whole write; the relation itself stays. */
export function fitsRelationReason(reason:string):boolean {
  return textWidth(reason.trim())<=RELATION_REASON_LIMIT;
}
