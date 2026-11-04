// A3.1: only the fresh install mutation payload may expose its known ROW date.
// Weak object identity prevents this response-local capability from becoming
// a caller-wide authorization cache or surviving a reload/clone of the row.
const freshPayloads=new WeakMap<object,{context:object;appId:string;agentId:string}>();
export function markNewInstallPayload<T extends {appId:string;agentId:string}>(row:T,context:object):T {
  freshPayloads.set(row,{context,appId:row.appId,agentId:row.agentId});
  return row;
}
export function isNewInstallPayload(row:{appId:string;agentId?:string},context:object):boolean {
  const marker=freshPayloads.get(row);
  return marker?.context===context && marker.appId===row.appId && marker.agentId===row.agentId;
}
