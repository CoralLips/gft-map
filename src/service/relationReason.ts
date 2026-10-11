/** A caption budget shared by model output, manual edits and the input. */
export const RELATION_REASON_LIMIT = 32;
export class RelationReasonLengthError extends Error {
  constructor() { super("\u627f\u63a5\u8bf4\u660e\u6700\u591a 32 \u5b57\uff0c\u8bf7\u53ea\u4fdd\u7559\u4e00\u53e5\u5173\u8054\u5f15\u5165\u3002");this.name='RelationReasonLengthError'; }
}
export function checkedRelationReason(reason:string):string {
  const text=reason.trim();
  if(Array.from(text).length>RELATION_REASON_LIMIT)throw new RelationReasonLengthError();
  return text;
}
