import * as React from 'react';
import { Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { readTextFile, writeTextFile } from '@/lib/fs';
import { cn } from '@/lib/utils';

interface InspectorMiniEditorProps {
  filePath: string;
  onClose: () => void;
}

export function InspectorMiniEditor({ filePath, onClose }: InspectorMiniEditorProps) {
  const [content, setContent] = React.useState('');
  const [savedContent, setSavedContent] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [readOnly, setReadOnly] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void readTextFile(filePath).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.code === 'too_large' ? 'File too large for mini editor' : 'Could not read file');
        setReadOnly(true);
        setLoading(false);
        return;
      }
      setContent(result.content);
      setSavedContent(result.content);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const dirty = content !== savedContent;

  const onSave = async () => {
    if (readOnly || !dirty) return;
    setSaving(true);
    const result = await writeTextFile(filePath, content);
    setSaving(false);
    if (!result.ok) {
      toast.error('Save failed', result.error.raw ?? result.error.code);
      return;
    }
    setSavedContent(content);
    toast.success('Saved', filePath.split(/[/\\]/).pop() ?? filePath);
  };

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent-copper/35 bg-elevated p-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-metadata font-medium text-foreground">{fileName}</span>
        {dirty ? (
          <span className="text-[10px] uppercase tracking-wide text-accent-copper">Unsaved</span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void onSave()}
          disabled={!dirty || readOnly || saving}
          aria-label="Save file"
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close editor">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="truncate font-mono text-[10px] text-muted-foreground" title={filePath}>
        {filePath}
      </p>
      {loading ? (
        <p className="text-secondary text-muted-foreground italic px-1 py-4">Loading…</p>
      ) : error ? (
        <p className="text-secondary text-destructive px-1 py-2">{error}</p>
      ) : (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          readOnly={readOnly}
          className={cn('min-h-[180px] max-h-[320px] font-mono text-[12px] resize-y')}
          spellCheck={false}
        />
      )}
    </div>
  );
}
