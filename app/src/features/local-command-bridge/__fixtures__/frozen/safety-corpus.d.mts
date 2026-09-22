export type Fixture = { name: string; text: string; words: number; expected: Array<{id:string;slots:Record<string,unknown>}>; route: string };
export function generateNegativeCorpus(seed:number,count?:number,targetWords?:number): Fixture[];
