import { useAuthStore } from './auth';

describe('useAuthStore API key persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAuthStore.setState({ apiKeys: {} });
  });

  it('does not persist secret provider keys to localStorage', () => {
    useAuthStore.getState().setApiKey('groq', 'gsk_secret_value');
    useAuthStore.getState().setApiKey('ollama', 'http://localhost:11434');

    const persisted = window.localStorage.getItem('jarvis-auth') ?? '';
    expect(persisted).not.toContain('gsk_secret_value');
    expect(persisted).toContain('http://localhost:11434');
  });
});
