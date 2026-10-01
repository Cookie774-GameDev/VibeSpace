import { CONCEPT_ORDER, getConcept } from './concepts.mjs';

const frame = document.querySelector('#concept-frame');
const openLink = document.querySelector('#open-concept');
const name = document.querySelector('#active-concept-name');
const thesis = document.querySelector('#active-concept-thesis');
const materials = document.querySelector('#active-concept-materials');
const buttons = [...document.querySelectorAll('[data-concept-target]')];

function selectConcept(id, updateHash = true) {
  const concept = getConcept(id);

  buttons.forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.conceptTarget === concept.id ? 'true' : 'false');
  });
  frame.src = concept.file;
  frame.title = `${concept.name} cinematic concept`;
  openLink.href = concept.file;
  name.textContent = concept.name;
  thesis.textContent = concept.thesis;
  materials.textContent = concept.materials.replaceAll(',', ' ·');

  if (updateHash) history.replaceState(null, '', `#${concept.id}`);
}

buttons.forEach((button) => {
  button.addEventListener('click', () => selectConcept(button.dataset.conceptTarget));
});

const requested = window.location.hash.slice(1);
selectConcept(CONCEPT_ORDER.includes(requested) ? requested : CONCEPT_ORDER[0], false);
