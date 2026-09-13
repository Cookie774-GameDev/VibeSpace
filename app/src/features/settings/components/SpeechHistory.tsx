import { useEffect, useState } from 'react';
import { Check, Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  deleteSpeechHistoryEntry,
  readSpeechHistory,
  speechHistoryStorageFailed,
  subscribeSpeechHistory,
} from '@/features/composer-stt/speechHistory';

export function SpeechHistory() {
  const [entries, setEntries] = useState(readSpeechHistory);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => subscribeSpeechHistory(() => setEntries(readSpeechHistory())), []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <section
      aria-label="Speech history"
      className="rounded-lg border border-border bg-panel p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-ui-strong text-foreground">Speech history</h3>
        <span className="text-metadata text-muted-foreground">{entries.length} / 50</span>
      </div>
      <p className="text-metadata text-muted-foreground">
        Your latest 50 talks, saved on this device as text arrives—even if dictation stops. Deleted
        transcripts can be restored from Settings → General → Recycle Bin. Audio is not saved.
        Speech that has not been transcribed yet is not included.
      </p>
      {(error || speechHistoryStorageFailed()) && (
        <p role="alert" className="text-metadata text-destructive">
          {error || 'Voice history could not be saved on this device. Check available storage.'}
        </p>
      )}
      {!entries.length ? (
        <p className="py-3 text-secondary text-muted-foreground">
          Your dictated text will appear here.
        </p>
      ) : (
        <ol className="max-h-80 overflow-y-auto divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.id} className="py-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-metadata text-muted-foreground">
                  <time dateTime={new Date(entry.startedAt).toISOString()}>
                    {new Date(entry.startedAt).toLocaleString()}
                  </time>
                  {' · '}
                  {entry.status === 'completed'
                    ? 'Completed'
                    : entry.status === 'interrupted'
                      ? 'Interrupted · text saved'
                      : 'Saved while speaking'}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Copy transcript"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(entry.text);
                        setCopied(entry.id);
                        setError('');
                      } catch {
                        setError('Could not copy. Select the text below and copy it manually.');
                      }
                    }}
                  >
                    {copied === entry.id ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copied === entry.id ? 'Copied' : 'Copy'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Delete transcript"
                    onClick={() => {
                      if (!deleteSpeechHistoryEntry(entry.id))
                        setError('Could not move this transcript to the Recycle Bin. It was kept.');
                      else setError('');
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words select-text text-secondary text-foreground">
                {entry.text}
              </p>
            </li>
          ))}
        </ol>
      )}
      <span role="status" className="sr-only">
        {copied ? 'Transcript copied' : ''}
      </span>
    </section>
  );
}
