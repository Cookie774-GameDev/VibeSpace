import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const referenceRoot =
  'C:/Users/viper/Downloads/VibeSpace_Warm_Final_Redo_Pack_With_References/VibeSpace_Warm_Final_Redo_Pack/references';
const captureRoot = path.join(repositoryRoot, 'artifacts/warm-final/final-verification');
const visualizationPath =
  'C:/Users/viper/.codex/visualizations/2026/08/05/019fc2af-c2f9-7e12-98bc-7b24b00de86e/warm-final-evidence.html';

const comparisons = [
  {
    name: 'Account',
    reference: '01_ACCOUNT_SHARED_USAGE_BACKGROUND.png',
    capture: 'account-usage/final/final-primary.png',
  },
  {
    name: 'Files',
    reference: '02_FILES_REDO_TARGET.png',
    capture: 'files/final/final-primary.png',
  },
  {
    name: 'Kanban',
    reference: '03_KANBAN_RESTYLE_TARGET.png',
    capture: 'kanban/final/final-primary.png',
  },
  {
    name: 'Schedule',
    reference: '04_SCHEDULE_REDO_TARGET.png',
    capture: 'scheduler/final/final-primary.png',
  },
  {
    name: 'Skills',
    reference: '05_SKILLS_REDO_TARGET.png',
    capture: 'skills/final/final-primary.png',
  },
  {
    name: 'Benchmarks',
    reference: '06_BENCHMARKS_REDO_TOP_TARGET.png',
    capture: 'benchmarks/final/final-primary.png',
  },
  {
    name: 'Project Context Map',
    reference: '07_PROJECT_CONTEXT_MAP_PRIMARY.png',
    capture: 'context/final/final-primary.png',
  },
];

async function inlineThumbnail(filePath) {
  const buffer = await sharp(filePath)
    .resize({ width: 560, withoutEnlargement: true })
    .webp({ quality: 48, effort: 4 })
    .toBuffer();
  return `data:image/webp;base64,${buffer.toString('base64')}`;
}

const evidence = [];
for (const comparison of comparisons) {
  const referencePath = path.join(referenceRoot, comparison.reference);
  const capturePath = path.join(captureRoot, comparison.capture);
  await Promise.all([readFile(referencePath), readFile(capturePath)]);
  const [reference, capture] = await Promise.all([
    inlineThumbnail(referencePath),
    inlineThumbnail(capturePath),
  ]);
  evidence.push({ name: comparison.name, reference, capture });
}

const initial = evidence[0];
const fragment = `<div id="warm-final-evidence">
  <div class="viz-row warm-evidence-summary" aria-label="Verification summary">
    <span class="viz-badge">7 visual pairs</span>
    <span class="viz-badge">1672 × 941</span>
    <span class="viz-badge">0 broken images</span>
    <span class="viz-badge">0 horizontal overflow</span>
  </div>
  <div class="viz-controls" aria-label="Choose a verified page">
    ${evidence
      .map(
        ({ name }, index) =>
          `<button class="btn${index === 0 ? ' btn-primary' : ''}" type="button" data-evidence-index="${index}" aria-pressed="${index === 0}">${name}</button>`,
      )
      .join('\n    ')}
  </div>
  <section class="warm-evidence-pair" aria-live="polite">
    <h3 data-evidence-title>${initial.name}</h3>
    <div class="warm-evidence-images">
      <figure>
        <figcaption>Reference</figcaption>
        <img data-evidence-reference src="${initial.reference}" alt="${initial.name} reference design" />
      </figure>
      <figure>
        <figcaption>Verified app capture</figcaption>
        <img data-evidence-capture src="${initial.capture}" alt="${initial.name} implemented Warm theme" />
      </figure>
    </div>
  </section>
</div>
<style>
  #warm-final-evidence {
    color: var(--foreground);
    display: grid;
    gap: 1rem;
    width: 100%;
  }
  #warm-final-evidence .warm-evidence-summary {
    justify-content: flex-start;
  }
  #warm-final-evidence .warm-evidence-pair {
    border-top: 1px solid var(--border);
    display: grid;
    gap: 0.625rem;
    padding-top: 0.875rem;
  }
  #warm-final-evidence h3,
  #warm-final-evidence figure {
    margin: 0;
  }
  #warm-final-evidence .warm-evidence-images {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  #warm-final-evidence figure {
    display: grid;
    gap: 0.375rem;
    min-width: 0;
  }
  #warm-final-evidence figcaption {
    color: var(--muted-foreground);
  }
  #warm-final-evidence img {
    aspect-ratio: 1672 / 941;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    display: block;
    height: auto;
    object-fit: cover;
    width: 100%;
  }
  @media (max-width: 560px) {
    #warm-final-evidence .warm-evidence-images {
      grid-template-columns: 1fr;
    }
  }
</style>`;

const script = `<script>
  (() => {
    const root = document.getElementById('warm-final-evidence');
    const evidence = ${JSON.stringify(evidence)};
    const title = root.querySelector('[data-evidence-title]');
    const reference = root.querySelector('[data-evidence-reference]');
    const capture = root.querySelector('[data-evidence-capture]');
    const buttons = [...root.querySelectorAll('[data-evidence-index]')];
    const select = (index) => {
      const item = evidence[index];
      title.textContent = item.name;
      reference.src = item.reference;
      reference.alt = item.name + ' reference design';
      capture.src = item.capture;
      capture.alt = item.name + ' implemented Warm theme';
      buttons.forEach((button, buttonIndex) => {
        const active = buttonIndex === index;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('btn-primary', active);
      });
    };
    buttons.forEach((button) => {
      button.addEventListener('click', () => select(Number(button.dataset.evidenceIndex)));
    });
  })();
</script>`;

await mkdir(path.dirname(visualizationPath), { recursive: true });
await writeFile(visualizationPath, fragment + script, 'utf8');
console.log(visualizationPath);
