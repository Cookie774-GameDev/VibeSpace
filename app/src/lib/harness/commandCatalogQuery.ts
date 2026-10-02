import type { ActionDef } from '@/lib/actions/types';
export interface CommandCatalogQuery { limit?: number; query?: string; offset?: number; details?: boolean }
/** Read-only discovery; preserve legacy array responses unless details is explicitly requested. */
export function queryCommandCatalog(actions: readonly ActionDef[], args: CommandCatalogQuery) {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('command_list_bounds_invalid');
  if (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 512 || args.query.includes('\0'))) throw new Error('command_list_query_invalid');
  if (args.details !== undefined && typeof args.details !== 'boolean') throw new Error('command_list_details_invalid');
  const query = args.query?.trim().toLocaleLowerCase('en-US');
  const exact = query ? actions.find(action => action.id.toLocaleLowerCase('en-US') === query) : undefined;
  const filtered = exact ? [exact] : query ? actions.filter(action => [action.id, action.label, action.description].some(value => value?.toLocaleLowerCase('en-US').includes(query))) : actions;
  const items = filtered.slice(offset, offset + limit).map(({id,label,description,category,destructive,params}) => ({ id,label,description,category,destructive:Boolean(destructive),params:params.map(({key,type,required})=>({key,type,required:Boolean(required)})) }));
  if (args.details !== true) return items;
  const consumed = Math.min(offset + items.length, filtered.length);
  const truncated = consumed < filtered.length;
  return { items, total:filtered.length, offset, nextOffset:truncated && items.length > 0 ? consumed : null, truncated };
}
