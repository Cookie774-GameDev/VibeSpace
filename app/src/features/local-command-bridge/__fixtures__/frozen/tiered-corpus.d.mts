export type Fixture = { name: string; text: string; words: number; expected: Array<{id:string;slots:Record<string,unknown>}>; route: string };
export function generateTieredCorpus(seed?:number): {high:Fixture[];xhigh:Fixture[];max:Fixture[]};
