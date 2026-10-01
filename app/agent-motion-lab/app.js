// VibeSpaceOS – Living Creative OS
const concepts = [
  { name: 'Glyph Current', tag: 'Inline', category: 'glyph', status: 'Planning response', meta: 'thinking · 04s', description: 'Codex-inspired, softened for long loops.', duration: '2.8s', type: 'glyph' },
  { name: 'Letter Relay', tag: 'Inline', category: 'glyph', status: 'Working through it', meta: 'reasoning · 12s', description: 'A calm character-by-character handoff.', duration: '2.1s', type: 'letters' },
  { name: 'Liquid Letter', tag: 'Brand', category: 'glyph form', status: 'Building context', meta: 'reading · 08s', description: 'A branded fill with restrained depth.', duration: '3.0s', type: 'liquid' },
  { name: 'Type & Dissolve', tag: 'Transition', category: 'glyph', status: 'Preparing answer', meta: 'composing · 15s', description: 'Types once, rests, then quietly resets.', duration: '3.4s', type: 'type' },
  { name: 'Nine-Dot Fold', tag: 'Core', category: 'dots', status: 'Coordinating agents', meta: 'orchestration · 09s', description: 'A grid collapses inward, then re-forms.', duration: '2.8s', type: 'dot-fold' },
  { name: 'Six-Dot Orbit', tag: 'Ambient', category: 'dots path', status: 'Exploring options', meta: 'planning · 06s', description: 'Slow orbital rhythm for longer waits.', duration: '4.2s', type: 'orbit' },
  { name: 'Dot Weave', tag: 'Handoff', category: 'dots path', status: 'Passing tool output', meta: 'handoff · 03s', description: 'Two lanes exchange work in sequence.', duration: '2.8s', type: 'weave' },
  { name: 'Magnetic Matrix', tag: 'System', category: 'dots form', status: 'Mapping dependencies', meta: 'analysis · 11s', description: 'Sixteen cells respond like one field.', duration: '2.5s', type: 'matrix' },
  { name: 'Constellation Trace', tag: 'Research', category: 'path dots', status: 'Connecting sources', meta: 'research · 17s', description: 'A signal travels between known points.', duration: '2.9s', type: 'constellation' },
  { name: 'Signal Comet', tag: 'Fast', category: 'path signal', status: 'Reading files', meta: '7 files · 02s', description: 'Directional progress without a percentage.', duration: '2.4s', type: 'comet' },
  { name: 'Arc Relay', tag: 'Neutral', category: 'path form', status: 'Evaluating result', meta: 'review · 05s', description: 'A familiar spinner with less visual churn.', duration: '3.2s', type: 'arc' },
  { name: 'Twin Loop', tag: 'Ambient', category: 'path form', status: 'Keeping context alive', meta: 'memory · 21s', description: 'Counter-rotating paths create a soft knot.', duration: '3.6s', type: 'loops' },
  { name: 'Breadcrumb Runner', tag: 'Stages', category: 'path signal', status: 'Plan · Read · Edit · Test', meta: 'stage 2 of 4', description: 'Best when the agent exposes real stages.', duration: '3.4s', type: 'breadcrumb' },
  { name: 'Quiet Equalizer', tag: 'Voice', category: 'signal', status: 'Listening for intent', meta: 'voice · live', description: 'A low-amplitude audio-inspired cadence.', duration: '1.65s', type: 'eq' },
  { name: 'Cursor Forge', tag: 'Terminal', category: 'signal glyph', status: 'Applying changes', meta: 'editing · 10s', description: 'A block cursor is forged into a progress rail.', duration: '2.7s', type: 'forge' },
  { name: 'Breathing Brackets', tag: 'Minimal', category: 'form glyph', status: 'Holding the thought', meta: 'reasoning · 07s', description: 'Two marks close around a single idea.', duration: '2.4s', type: 'brackets' },
  { name: 'Stack Shift', tag: 'Files', category: 'form', status: 'Indexing workspace', meta: '28 files · 14s', description: 'Document layers move through the active slot.', duration: '3.2s', type: 'stack' },
  { name: 'Code Shimmer', tag: 'Reading', category: 'signal', status: 'Inspecting implementation', meta: 'codebase · 19s', description: 'Light scans code lines without fake typing.', duration: '2.4s', type: 'code' },
  { name: 'Thought Bloom', tag: 'Signature', category: 'form dots', status: 'Expanding an idea', meta: 'creative · 13s', description: 'A VibeSpace signature with a quiet reset.', duration: '3.1s', type: 'bloom' },
  { name: 'Ribbon Fold', tag: 'Depth', category: 'form', status: 'Reframing approach', meta: 'planning · 16s', description: 'Five panels turn like a single soft ribbon.', duration: '2.7s', type: 'ribbon' },
  { name: 'Phase Cells', tag: 'Compact', category: 'signal form', status: 'Running checks', meta: 'test suite · 24s', description: 'A narrow status strip for dense layouts.', duration: '2.35s', type: 'cells' },
  { name: 'Focus Rings', tag: 'Deep Work', category: 'path form', status: 'Deep reasoning', meta: 'thinking · 31s', description: 'Layered attention without a busy spinner.', duration: 'variable', type: 'focus' },
  { name: 'Neural Handoff', tag: 'Agents', category: 'path signal', status: 'Agent handoff', meta: '3 workers · live', description: 'Parallel lanes show real multi-agent flow.', duration: '2.65s', type: 'handoff' },
  { name: 'Sine Dots', tag: 'Universal', category: 'dots signal', status: 'Still working', meta: 'background · 44s', description: 'The simplest option, tuned to feel deliberate.', duration: '1.8s', type: 'sine' }
]

const repeat = (count, className = '', style = '') => Array.from({ length: count }, (_, index) => `<span${className ? ` class='${className}'` : ''} style='--i:${index}${style}'></span>`).join('')

const visual = (type) => {
  switch (type) {
    case 'glyph':
      return `<div class='anim glyph-current' aria-hidden='true'><span class='fill-word' data-text='VIBE'>VIBE</span><span class='baseline'></span></div>`
    case 'letters':
      return `<div class='anim letter-relay' aria-hidden='true'>${[...'WORKING'].map((letter, index) => `<span style='--i:${index}'>${letter}</span>`).join('')}</div>`
    case 'liquid':
      return `<div class='anim liquid-letter' aria-hidden='true'><span class='shell-v'>V</span><span class='fill-v'>V</span><span class='surface'></span></div>`
    case 'type':
      return `<div class='anim type-dissolve' aria-hidden='true'><span class='typed'>Vibing…</span><span class='cursor'></span></div>`
    case 'dot-fold':
      return `<div class='anim dot-fold' aria-hidden='true'>${repeat(9)}</div>`
    case 'orbit':
      return `<div class='anim orbit-six' aria-hidden='true'>${repeat(6)}</div>`
    case 'weave':
      return `<div class='anim dot-weave' aria-hidden='true'>${repeat(6)}</div>`
    case 'matrix':
      return `<div class='anim matrix' aria-hidden='true'>${repeat(16)}</div>`
    case 'constellation':
      return `<div class='anim constellation' aria-hidden='true'><svg viewBox='0 0 82 54'><path d='M7 39 23 18 40 34 56 12 75 28'/><path class='trace' d='M7 39 23 18 40 34 56 12 75 28'/><circle cx='7' cy='39' r='2.4' style='--i:0'/><circle cx='23' cy='18' r='2.4' style='--i:1'/><circle cx='40' cy='34' r='2.4' style='--i:2'/><circle cx='56' cy='12' r='2.4' style='--i:3'/><circle cx='75' cy='28' r='2.4' style='--i:4'/></svg></div>`
    case 'comet':
      return `<div class='anim comet' aria-hidden='true'><span class='rail'>${'<i></i>'.repeat(6)}</span><b></b></div>`
    case 'arc':
      return `<div class='anim arc' aria-hidden='true'><svg viewBox='0 0 48 48'><circle cx='24' cy='24' r='18'/><circle class='live' cx='24' cy='24' r='18'/></svg><b></b></div>`
    case 'loops':
      return `<div class='anim twin-loop' aria-hidden='true'><span></span><span></span></div>`
    case 'breadcrumb':
      return `<div class='anim breadcrumb' aria-hidden='true'><div class='crumbs'>${repeat(4, 'crumb')}</div><span class='runner'></span></div>`
    case 'eq':
      return `<div class='anim eq' aria-hidden='true'>${repeat(9)}</div>`
    case 'forge':
      return `<div class='anim cursor-forge' aria-hidden='true'><span class='rail'></span><span class='cursor'></span></div>`
    case 'brackets':
      return `<div class='anim brackets' aria-hidden='true'><span class='bracket left'>[</span><span class='seed'></span><span class='bracket right'>]</span></div>`
    case 'stack':
      return `<div class='anim stack' aria-hidden='true'><span style='--i:0;--fill:.78'></span><span style='--i:1;--fill:.44'></span><span style='--i:2;--fill:.62'></span><span style='--i:3;--fill:.31'></span></div>`
    case 'code':
      return `<div class='anim code' aria-hidden='true'><span style='--i:0;--w:72px'></span><span style='--i:1;--w:51px'></span><span style='--i:2;--w:65px'></span><span style='--i:3;--w:39px'></span></div>`
    case 'bloom':
      return `<div class='anim bloom' aria-hidden='true'>${repeat(6, 'petal')}<span class='center'></span></div>`
    case 'ribbon':
      return `<div class='anim ribbon' aria-hidden='true'>${repeat(5)}</div>`
    case 'cells':
      return `<div class='anim cells' aria-hidden='true'>${repeat(8)}</div>`
    case 'focus':
      return `<div class='anim focus' aria-hidden='true'><span style='--size:30px;--duration:2.3s;--direction:normal'></span><span style='--size:42px;--duration:2.8s;--direction:reverse'></span><span style='--size:54px;--duration:3.3s;--direction:normal'></span><span class='core'></span></div>`
    case 'handoff':
      return `<div class='anim handoff' aria-hidden='true'><svg viewBox='0 0 92 52'><path d='M9 12C35 12 56 12 83 12M9 26C35 26 56 26 83 26M9 40C35 40 56 40 83 40'/><path class='live' style='--i:0' d='M9 12C35 12 56 12 83 12'/><path class='live' style='--i:1' d='M9 26C35 26 56 26 83 26'/><path class='live' style='--i:2' d='M9 40C35 40 56 40 83 40'/><circle cx='9' cy='12' r='2.6' style='--i:0'/><circle cx='9' cy='26' r='2.6' style='--i:1'/><circle cx='9' cy='40' r='2.6' style='--i:2'/><circle cx='83' cy='12' r='2.6' style='--i:3'/><circle cx='83' cy='26' r='2.6' style='--i:4'/><circle cx='83' cy='40' r='2.6' style='--i:5'/></svg></div>`
    case 'sine':
      return `<div class='anim sine' aria-hidden='true'>${repeat(12)}</div>`
    default:
      return ''
  }
}

const grid = document.querySelector('#motionGrid')

grid.innerHTML = concepts.map((concept, index) => `
  <article class='motion-card' data-category='${concept.category}'>
    <header class='card-head'>
      <div class='card-title'><span class='card-index'>${String(index + 1).padStart(2, '0')}</span><h2>${concept.name}</h2></div>
      <span class='card-tag'>${concept.tag}</span>
    </header>
    <div class='stage'>
      <div class='status-sample'>
        ${visual(concept.type)}
        <div class='status-copy'><strong>${concept.status}</strong><span>${concept.meta}</span></div>
      </div>
    </div>
    <footer class='card-foot'><p>${concept.description}</p><code>${concept.duration}</code></footer>
  </article>
`).join('')

const root = document.documentElement
const body = document.body
const pauseButton = document.querySelector('#pauseAll')
const pauseLabel = document.querySelector('#pauseLabel')
const speedRange = document.querySelector('#speedRange')
const speedReadout = document.querySelector('#speedReadout')
const sizeButtons = [...document.querySelectorAll('.size-control')]
const accentButtons = [...document.querySelectorAll('.accent-swatch')]
const filterButtons = [...document.querySelectorAll('.filter-chip')]
const cards = [...document.querySelectorAll('.motion-card')]
const visibleCount = document.querySelector('#visibleCount')
const emptyState = document.querySelector('#emptyState')

const setPaused = (paused) => {
  body.classList.toggle('is-paused', paused)
  pauseButton.setAttribute('aria-pressed', String(paused))
  pauseLabel.textContent = paused ? 'Play' : 'Pause'
}

pauseButton.addEventListener('click', () => setPaused(!body.classList.contains('is-paused')))

speedRange.addEventListener('input', (event) => {
  const rate = Number(event.target.value) / 100
  root.style.setProperty('--speed', String(1 / rate))
  speedReadout.value = `${rate.toFixed(1)}×`
  speedReadout.textContent = `${rate.toFixed(1)}×`
})

sizeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    sizeButtons.forEach((item) => item.setAttribute('aria-pressed', 'false'))
    button.setAttribute('aria-pressed', 'true')
    root.style.setProperty('--preview-scale', button.dataset.scale)
  })
})

accentButtons.forEach((button) => {
  button.addEventListener('click', () => {
    accentButtons.forEach((item) => item.setAttribute('aria-pressed', 'false'))
    button.setAttribute('aria-pressed', 'true')
    root.style.setProperty('--accent', button.dataset.accent)
    root.style.setProperty('--accent-rgb', button.dataset.rgb)
  })
})

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const filter = button.dataset.filter
    let count = 0

    filterButtons.forEach((item) => item.setAttribute('aria-pressed', 'false'))
    button.setAttribute('aria-pressed', 'true')

    cards.forEach((card) => {
      const matches = filter === 'all' || card.dataset.category.split(' ').includes(filter)
      card.classList.toggle('is-hidden', !matches)
      if (matches) count += 1
    })

    visibleCount.textContent = `${count} concept${count === 1 ? '' : 's'}`
    emptyState.classList.toggle('is-visible', count === 0)
  })
})

document.addEventListener('keydown', (event) => {
  const target = event.target
  const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement

  if (event.code === 'Space' && !isTyping) {
    event.preventDefault()
    setPaused(!body.classList.contains('is-paused'))
  }
})
