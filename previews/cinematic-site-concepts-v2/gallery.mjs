const portals = [...document.querySelectorAll('.world-portal')];
const clock = document.querySelector('[data-clock]');

function updateClock() {
  const now = new Date();
  clock.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

for (const portal of portals) {
  portal.addEventListener('pointermove', (event) => {
    const bounds = portal.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    portal.style.setProperty('--portal-x', `${(x * -1.7).toFixed(3)}%`);
    portal.style.setProperty('--portal-y', `${(y * -1.2).toFixed(3)}%`);
  });
  portal.addEventListener('pointerleave', () => {
    portal.style.setProperty('--portal-x', '0%');
    portal.style.setProperty('--portal-y', '0%');
  });
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      entry.target.toggleAttribute('data-in-view', entry.isIntersecting);
    }
  },
  { threshold: 0.5 },
);

document.querySelectorAll('.portal-shell').forEach((portal) => observer.observe(portal));
updateClock();
window.setInterval(updateClock, 1000);
