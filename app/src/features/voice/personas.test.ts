import { PERSONAS as ONBOARDING_PERSONAS } from '@/features/onboarding/steps/personas-data';
import { PERSONAS as AGENT_PERSONAS, PERSONA_LIST } from '@/features/agents/personas';
import { PERSONAS, PERSONA_ORDER } from './personas';

describe('voice persona catalog', () => {
  it('ships only Jarvis and Friday across every persona picker source', () => {
    expect(PERSONA_ORDER).toEqual(['jarvis', 'friday']);
    expect(Object.keys(PERSONAS)).toEqual(['jarvis', 'friday']);
    expect(ONBOARDING_PERSONAS.map(({ id }) => id)).toEqual(['jarvis', 'friday']);
    expect(PERSONA_LIST.map(({ id }) => id)).toEqual(['jarvis', 'friday']);
    expect(Object.keys(AGENT_PERSONAS)).toEqual(['jarvis', 'friday']);
  });
});
