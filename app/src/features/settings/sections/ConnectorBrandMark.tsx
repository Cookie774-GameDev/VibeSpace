import { cn } from '@/lib/utils';

export interface ConnectorBrandMarkProps {
  providerId: string;
  connectionId: string;
  className?: string;
  title?: string;
}

interface BrandDefinition {
  background: string;
  foreground: string;
  source: string;
  path?: string;
  wordmark?: string;
  wordmarkSize?: number;
}

/**
 * Audited provider identity catalog.
 *
 * Marks are rendered locally: no remote image request, tracking pixel, or
 * startup fetch. Geometry follows each provider's published mark or current
 * Simple Icons brand path. When a provider does not license a standalone mark
 * for third-party UI (notably Groq), we use its truthful full word name rather
 * than inventing a monogram.
 */
const BRANDS: Readonly<Record<string, BrandDefinition>> = Object.freeze({
  openai: {
    background: '#0d0d0d',
    foreground: '#ffffff',
    source: 'https://openai.com/brand/',
    path: 'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.68zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L11.01 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z',
  },
  anthropic: {
    background: '#d4a27f',
    foreground: '#191919',
    source: 'https://www.anthropic.com/',
    path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  },
  google: {
    background: '#ffffff',
    foreground: '#4e82ee',
    source: 'https://gemini.google.com/',
    path: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
  },
  github: {
    background: '#24292f',
    foreground: '#ffffff',
    source: 'https://github.com/logos',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  qwen: {
    background: '#ff6a00',
    foreground: '#ffffff',
    source: 'https://www.alibabacloud.com/product/model-studio',
    path: 'M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z',
  },
  deepseek: {
    background: '#4d6bfe',
    foreground: '#ffffff',
    source: 'https://www.deepseek.com/',
    path: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.423.453-.857.795-1.51.763-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.91-.4-1.133-.737-1.56-1.825-.133-.34-.427-.35-.62-.003-.8 1.46-.28 4.01 1.685 5.337.137.094.172.187.129.323-.137.469-.2.69-.594.442-1.88-1.18-3.005-2.988-4.95-4.24-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-1.382.006-2.518.74-3.152.82-4.074-.78-7.64 1.22-8.71 5.857-1.23 5.33 3.055 10.93 9.798 10.53 2.04.18 3.545-.23 4.994-1.86 1.28.64 3.735.53 3.9-.265.12-.57-1.42-.71-2.11-1.275 1.095-1.295 2.768-3.598 3.284-6.733.08-.55.1-1.19.338-1.37 2.41-.2 3.48-1.85 3.638-3.64.02-.23-.004-.467-.247-.588M11.58 18.168c-5.85-4.6-3.98-.2-3.49-.66.42.59.53.84.03 1.12-1.58.87-4.28-2.13-5.24-3.99-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592 4.84-.88 7.78 2.82 9.2 5.63 1.03 2.03 2.41 3.13 3.38 3.59-.8.09-2.14.109-3.055-.615Z',
  },
  mistral: {
    background: '#ff7000',
    foreground: '#111111',
    source: 'https://mistral.ai/',
    path: 'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z',
  },
  perplexity: {
    background: '#1f7a7a',
    foreground: '#ffffff',
    source: 'https://www.perplexity.ai/',
    path: 'M22.398 7.09h-2.311V.068l-7.51 6.354V.158h-1.155v6.197L4.49 0v7.09H1.602v10.397H4.49V24l6.932-6.359v6.2h1.156v-6.046l6.932 6.18v-6.488h2.888zm-3.466-4.531V7.09h-5.355zm-13.286.067 4.869 4.463H5.646zM2.758 16.332V8.245h7.847L4.49 14.36v1.972zm2.888 5.04v-6.534l5.776-5.776v7.011zm12.708.025-5.776-5.151V9.062l5.776 5.776zm2.889-5.065H19.51V14.36l-6.115-6.115h7.848z',
  },
  openrouter: {
    background: '#6366f1',
    foreground: '#ffffff',
    source: 'https://openrouter.ai/',
    path: 'M16.778 1.844v1.919c-3.05-.14-5.88.13-8.702 2.242-2.911 2.066-2.731 1.95-4.14 2.75C2.7 9.45 0 9.886 0 9.886v4.229s2.56.42 3.795 1.132c1.41.798 1.228.683 4.14 2.75 2.82 2.11 5.65 2.38 8.703 2.24v1.919l7.222-4.168-7.222-4.17v2.176c-2.36.1-3.91.14-6.257-1.444-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 2.34-1.58 3.89-1.54 6.255-1.436v2.176L24 6.014Z',
  },
  replicate: {
    background: '#000000',
    foreground: '#ffffff',
    source: 'https://replicate.com/',
    path: 'M24 10.262v2.712h-9.518V24h-3.034V10.262zm0-5.131v2.717H8.755V24H5.722V5.131zM24 0v2.717H3.034V24H0V0z',
  },
  opencode: {
    background: '#0a0a0a',
    foreground: '#34d399',
    source: 'https://opencode.ai/',
    path: 'M22 24H2V0h20zM17 4.8H7v14.4h10z',
  },
  deepgram: {
    background: '#071b14',
    foreground: '#13ef93',
    source: 'https://deepgram.com/',
    path: 'M11.203 24H1.517a.364.364 0 0 1-.258-.62l6.239-6.275a.366.366 0 0 1 .259-.108h3.52c2.723 0 5.025-2.127 5.107-4.845a5.004 5.004 0 0 0-4.999-5.148H7.613v4.646c0 .2-.164.364-.365.364H.968a.365.365 0 0 1-.363-.364V.364C.605.164.768 0 .969 0h10.416c6.684 0 12.111 5.485 12.01 12.187C23.293 18.77 17.794 24 11.202 24z',
  },
  // Full official names are deliberate brand-safe fallbacks, never initials.
  xai: wordmark('#000000', '#ffffff', 'xAI', 'https://x.ai/', 11),
  groq: wordmark('#f55036', '#ffffff', 'groq', 'https://groq.com/trademark-policy', 9),
  cerebras: wordmark('#ff5f15', '#111111', 'CEREBRAS', 'https://www.cerebras.ai/', 5.2),
  fireworks: wordmark('#111827', '#ffffff', 'fireworks', 'https://fireworks.ai/', 5),
  together: wordmark('#111111', '#ffffff', 'together', 'https://www.together.ai/brand', 5.4),
  cohere: wordmark('#39594d', '#ffffff', 'cohere', 'https://cohere.com/', 6.5),
  huggingface: wordmark('#ffd21e', '#111111', '🤗', 'https://huggingface.co/brand', 13),
  azure: wordmark('#0078d4', '#ffffff', 'AZURE', 'https://azure.microsoft.com/', 6),
  bedrock: wordmark('#232f3e', '#ff9900', 'AWS', 'https://aws.amazon.com/bedrock/', 8),
  hyperbolic: wordmark('#111111', '#52e2a8', 'hyperbolic', 'https://hyperbolic.xyz/', 4.7),
  novita: wordmark('#6d28d9', '#ffffff', 'novita', 'https://novita.ai/', 6),
  lambda: wordmark('#111111', '#eaff00', 'Lambda', 'https://lambda.ai/', 5.7),
  ollama: wordmark('#ffffff', '#111111', 'OLLAMA', 'https://ollama.com/', 5.8),
  zai: wordmark('#111827', '#ffffff', 'Z.AI', 'https://z.ai/', 7.5),
});

function wordmark(
  background: string,
  foreground: string,
  value: string,
  source: string,
  wordmarkSize: number,
): BrandDefinition {
  return { background, foreground, wordmark: value, source, wordmarkSize };
}

export function ConnectorBrandMark({
  providerId,
  connectionId,
  className,
  title,
}: ConnectorBrandMarkProps) {
  const label = title ?? connectionId;
  const brand = BRANDS[providerId];
  const audited = Boolean(brand);
  const artwork = brand ?? wordmark('#f1f1f1', '#202020', providerId, '', 5);

  return (
    <span
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/70 shadow-sm [html[data-theme=monochrome]_&]:grayscale [html[data-theme=monochrome]_&]:shadow-none',
        className,
      )}
      style={{ background: artwork.background }}
      role="img"
      aria-label={label}
      title={label}
      data-provider-id={providerId}
      data-brand-status={audited ? 'audited' : 'unverified'}
      data-brand-source={artwork.source || undefined}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        {artwork.path ? (
          <path fill={artwork.foreground} d={artwork.path} />
        ) : (
          <text
            x="12"
            y="12.5"
            fill={artwork.foreground}
            fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
            fontSize={artwork.wordmarkSize}
            fontWeight="750"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {artwork.wordmark}
          </text>
        )}
      </svg>
    </span>
  );
}
